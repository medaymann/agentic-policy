use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("2oYHgAYscSG4JvQcKcUq4oFGsDFU2SRBtFYFnHxpzgtu");

// ── Action types an agent may attempt ────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum ActionType {
    Transfer,
    Swap,
    Stake,
    ContractCall,
}

// ── Intent / receipt status ───────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum IntentStatus {
    Pending,
    Approved,
    Rejected,
    Executed,
}

// ── Error codes ───────────────────────────────────────────────────────────────

#[error_code]
pub enum BasiraError {
    #[msg("Value exceeds policy maximum")]
    ValueExceedsLimit,
    #[msg("Action type not permitted by policy")]
    ActionNotPermitted,
    #[msg("Intent has not been approved")]
    IntentNotApproved,
    #[msg("Intent already finalised")]
    IntentAlreadyFinalised,
    #[msg("Rate limit exceeded for current window")]
    RateLimitExceeded,
    #[msg("Signer is not the policy authority")]
    UnauthorizedPolicyUpdate,
    #[msg("Action type not yet supported for on-chain execution")]
    UnsupportedActionCpi,
    #[msg("Transfer intents require a recipient")]
    RecipientRequired,
    #[msg("Recipient account does not match the approved intent")]
    RecipientMismatch,
}

// ── Accounts ──────────────────────────────────────────────────────────────────

/// Persistent identity record for a registered agent.
#[account]
pub struct AgentAccount {
    pub authority: Pubkey,         // signs intents + executes
    pub policy_authority: Pubkey,  // signs policy updates
    pub name: String,              // max 32 chars
    pub policy: RiskPolicy,
    pub intent_count: u64,
    pub window_start_ts: i64,      // rolling window anchor (unix seconds)
    pub count_in_window: u32,      // approved intents since window_start_ts
    pub vault_bump: u8,            // bump for the agent's vault PDA
    pub bump: u8,
}

/// Inline policy stored with the agent.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RiskPolicy {
    /// Maximum lamports the agent may move in a single intent.
    pub max_value_lamports: u64,
    /// Bitmask: bit 0 = Transfer, 1 = Swap, 2 = Stake, 3 = ContractCall.
    pub allowed_actions_mask: u8,
    /// Length of the rate-limit window in seconds. 0 disables rate limiting.
    pub window_seconds: i64,
    /// Maximum approved intents per window.
    pub max_per_window: u32,
}

impl RiskPolicy {
    pub fn allows_action(&self, action: &ActionType) -> bool {
        let bit = match action {
            ActionType::Transfer    => 0,
            ActionType::Swap        => 1,
            ActionType::Stake       => 2,
            ActionType::ContractCall => 3,
        };
        self.allowed_actions_mask & (1 << bit) != 0
    }
}

/// A single proposed action, evaluated against the agent's policy.
#[account]
pub struct IntentRequest {
    pub agent: Pubkey,
    pub action_type: ActionType,
    pub value_lamports: u64,
    pub recipient: Pubkey,                 // Pubkey::default() if not applicable
    pub status: IntentStatus,
    pub rejection_reason: Option<String>,  // set on Rejected
    pub submitted_at: i64,
    pub finalised_at: Option<i64>,
    pub seq: u64,                          // monotonic per agent
    pub bump: u8,
}

/// Immutable onchain proof that an intent was executed.
#[account]
pub struct ExecutionReceipt {
    pub agent: Pubkey,
    pub intent_seq: u64,
    pub action_type: ActionType,
    pub value_lamports: u64,
    pub recipient: Pubkey,
    pub executed_at: i64,
    pub bump: u8,
}

// ── Space helpers ─────────────────────────────────────────────────────────────

impl AgentAccount {
    // discriminator(8)
    // + authority(32) + policy_authority(32)
    // + name(4+32)
    // + policy: max_value(8) + mask(1) + window_seconds(8) + max_per_window(4) = 21
    // + intent_count(8)
    // + window_start_ts(8) + count_in_window(4)
    // + vault_bump(1) + bump(1)
    pub const SPACE: usize =
        8 + 32 + 32 + (4 + 32) + 21 + 8 + 8 + 4 + 1 + 1;
}

impl IntentRequest {
    // discriminator(8) + agent(32) + action(1) + value(8) + recipient(32)
    // + status(1) + option<string>(1+4+64) + submitted_at(8)
    // + option<i64>(1+8) + seq(8) + bump(1)
    pub const SPACE: usize =
        8 + 32 + 1 + 8 + 32 + 1 + (1 + 4 + 64) + 8 + (1 + 8) + 8 + 1;
}

impl ExecutionReceipt {
    // discriminator(8) + agent(32) + intent_seq(8) + action(1)
    // + value(8) + recipient(32) + executed_at(8) + bump(1)
    pub const SPACE: usize = 8 + 32 + 8 + 1 + 8 + 32 + 8 + 1;
}

// ── Program ───────────────────────────────────────────────────────────────────

#[program]
pub mod basira {
    use super::*;

    /// Register a new agent with a name and an initial risk policy.
    /// If `policy_authority` is None, the calling authority owns the policy.
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        name: String,
        max_value_lamports: u64,
        allowed_actions_mask: u8,
        window_seconds: i64,
        max_per_window: u32,
        policy_authority: Option<Pubkey>,
    ) -> Result<()> {
        require!(name.len() <= 32, BasiraError::ActionNotPermitted);

        let clock = Clock::get()?;
        let agent = &mut ctx.accounts.agent_account;
        agent.authority = ctx.accounts.authority.key();
        agent.policy_authority = policy_authority.unwrap_or_else(|| ctx.accounts.authority.key());
        agent.name = name;
        agent.policy = RiskPolicy {
            max_value_lamports,
            allowed_actions_mask,
            window_seconds,
            max_per_window,
        };
        agent.intent_count = 0;
        agent.window_start_ts = clock.unix_timestamp;
        agent.count_in_window = 0;
        agent.vault_bump = ctx.bumps.vault;
        agent.bump = ctx.bumps.agent_account;

        emit!(AgentRegistered {
            agent: agent.key(),
            authority: agent.authority,
            policy_authority: agent.policy_authority,
            max_value_lamports,
            allowed_actions_mask,
            window_seconds,
            max_per_window,
        });

        Ok(())
    }

    /// Submit an intent. The policy engine evaluates it inline.
    /// Status is set to Approved or Rejected before returning.
    pub fn submit_intent(
        ctx: Context<SubmitIntent>,
        action_type: ActionType,
        value_lamports: u64,
        recipient: Option<Pubkey>,
    ) -> Result<()> {
        let agent = &mut ctx.accounts.agent_account;
        let intent = &mut ctx.accounts.intent_request;
        let clock = Clock::get()?;

        let seq = agent.intent_count;
        agent.intent_count += 1;

        intent.agent = agent.key();
        intent.action_type = action_type.clone();
        intent.value_lamports = value_lamports;
        intent.recipient = recipient.unwrap_or_default();
        intent.submitted_at = clock.unix_timestamp;
        intent.finalised_at = None;
        intent.seq = seq;
        intent.bump = ctx.bumps.intent_request;

        // ── Policy evaluation ─────────────────────────────────────────────────
        if !agent.policy.allows_action(&action_type) {
            intent.status = IntentStatus::Rejected;
            intent.rejection_reason = Some("action type not permitted".to_string());
            emit!(IntentEvaluated { agent: agent.key(), seq, approved: false });
            return Ok(());
        }

        if value_lamports > agent.policy.max_value_lamports {
            intent.status = IntentStatus::Rejected;
            intent.rejection_reason = Some("value exceeds policy limit".to_string());
            emit!(IntentEvaluated { agent: agent.key(), seq, approved: false });
            return Ok(());
        }

        // Transfer intents must name a recipient.
        if matches!(action_type, ActionType::Transfer) && intent.recipient == Pubkey::default() {
            intent.status = IntentStatus::Rejected;
            intent.rejection_reason = Some("transfer requires recipient".to_string());
            emit!(IntentEvaluated { agent: agent.key(), seq, approved: false });
            return Ok(());
        }

        // Rate limit (count approved intents per rolling window).
        if agent.policy.window_seconds > 0 {
            if clock.unix_timestamp.saturating_sub(agent.window_start_ts)
                >= agent.policy.window_seconds
            {
                agent.window_start_ts = clock.unix_timestamp;
                agent.count_in_window = 0;
            }
            if agent.count_in_window >= agent.policy.max_per_window {
                intent.status = IntentStatus::Rejected;
                intent.rejection_reason = Some("rate limit exceeded".to_string());
                emit!(IntentEvaluated { agent: agent.key(), seq, approved: false });
                return Ok(());
            }
            agent.count_in_window += 1;
        }

        intent.status = IntentStatus::Approved;
        intent.rejection_reason = None;
        emit!(IntentEvaluated { agent: agent.key(), seq, approved: true });

        Ok(())
    }

    /// Execute an approved intent. For Transfer, performs a real SystemProgram
    /// CPI from the agent's vault PDA to the approved recipient. The receipt
    /// is only written if the inner action succeeds.
    pub fn execute_intent(ctx: Context<ExecuteIntent>) -> Result<()> {
        let intent = &mut ctx.accounts.intent_request;
        require!(intent.status == IntentStatus::Approved, BasiraError::IntentNotApproved);

        // Branch on the action: only Transfer is wired in v1.
        match intent.action_type {
            ActionType::Transfer => {
                require!(
                    ctx.accounts.recipient.key() == intent.recipient,
                    BasiraError::RecipientMismatch
                );

                let agent_key = ctx.accounts.agent_account.key();
                let vault_bump = ctx.accounts.agent_account.vault_bump;
                let seeds: &[&[u8]] = &[b"vault", agent_key.as_ref(), &[vault_bump]];
                let signer_seeds: &[&[&[u8]]] = &[seeds];

                let cpi_ctx = CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.recipient.to_account_info(),
                    },
                    signer_seeds,
                );
                system_program::transfer(cpi_ctx, intent.value_lamports)?;
            }
            _ => return err!(BasiraError::UnsupportedActionCpi),
        }

        let clock = Clock::get()?;
        intent.status = IntentStatus::Executed;
        intent.finalised_at = Some(clock.unix_timestamp);

        let receipt = &mut ctx.accounts.execution_receipt;
        receipt.agent = intent.agent;
        receipt.intent_seq = intent.seq;
        receipt.action_type = intent.action_type.clone();
        receipt.value_lamports = intent.value_lamports;
        receipt.recipient = intent.recipient;
        receipt.executed_at = clock.unix_timestamp;
        receipt.bump = ctx.bumps.execution_receipt;

        emit!(ReceiptWritten {
            agent: receipt.agent,
            intent_seq: receipt.intent_seq,
            value_lamports: receipt.value_lamports,
            recipient: receipt.recipient,
            executed_at: receipt.executed_at,
        });

        Ok(())
    }

    /// Replace the agent's risk policy. Must be signed by `policy_authority`.
    /// Resets the rate-limit window so a new policy applies from `now`.
    pub fn update_policy(
        ctx: Context<UpdatePolicy>,
        max_value_lamports: u64,
        allowed_actions_mask: u8,
        window_seconds: i64,
        max_per_window: u32,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let agent = &mut ctx.accounts.agent_account;

        // The `has_one = policy_authority` constraint on the context already
        // enforces signer == agent.policy_authority. This require! makes the
        // intent explicit and gives a clearer error code.
        require!(
            ctx.accounts.policy_authority.key() == agent.policy_authority,
            BasiraError::UnauthorizedPolicyUpdate
        );

        agent.policy = RiskPolicy {
            max_value_lamports,
            allowed_actions_mask,
            window_seconds,
            max_per_window,
        };
        agent.window_start_ts = clock.unix_timestamp;
        agent.count_in_window = 0;

        emit!(PolicyUpdated {
            agent: agent.key(),
            max_value_lamports,
            allowed_actions_mask,
            window_seconds,
            max_per_window,
        });

        Ok(())
    }
}

// ── Contexts ──────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(name: String)]
pub struct RegisterAgent<'info> {
    #[account(
        init,
        payer = authority,
        space = AgentAccount::SPACE,
        seeds = [b"agent", authority.key().as_ref()],
        bump,
    )]
    pub agent_account: Account<'info, AgentAccount>,

    /// CHECK: system-owned PDA used as the agent's lamport vault. Address is
    /// derived from `agent_account` here so we can capture and store its bump
    /// at registration time; it holds no data.
    #[account(
        seeds = [b"vault", agent_account.key().as_ref()],
        bump,
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitIntent<'info> {
    #[account(
        mut,
        seeds = [b"agent", authority.key().as_ref()],
        bump = agent_account.bump,
        has_one = authority,
    )]
    pub agent_account: Account<'info, AgentAccount>,

    #[account(
        init,
        payer = authority,
        space = IntentRequest::SPACE,
        seeds = [b"intent", agent_account.key().as_ref(), &agent_account.intent_count.to_le_bytes()],
        bump,
    )]
    pub intent_request: Account<'info, IntentRequest>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteIntent<'info> {
    #[account(
        mut,
        seeds = [b"intent", agent_account.key().as_ref(), &intent_request.seq.to_le_bytes()],
        bump = intent_request.bump,
        has_one = agent,
    )]
    pub intent_request: Account<'info, IntentRequest>,

    /// CHECK: used only as a key reference for the receipt PDA seed.
    #[account(address = intent_request.agent)]
    pub agent: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"agent", authority.key().as_ref()],
        bump = agent_account.bump,
        has_one = authority,
        constraint = agent_account.key() == intent_request.agent,
    )]
    pub agent_account: Account<'info, AgentAccount>,

    #[account(
        mut,
        seeds = [b"vault", agent_account.key().as_ref()],
        bump = agent_account.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    /// CHECK: recipient is verified against `intent_request.recipient` in handler.
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    #[account(
        init,
        payer = authority,
        space = ExecutionReceipt::SPACE,
        seeds = [b"receipt", agent_account.key().as_ref(), &intent_request.seq.to_le_bytes()],
        bump,
    )]
    pub execution_receipt: Account<'info, ExecutionReceipt>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    #[account(
        mut,
        seeds = [b"agent", agent_account.authority.as_ref()],
        bump = agent_account.bump,
        has_one = policy_authority,
    )]
    pub agent_account: Account<'info, AgentAccount>,

    pub policy_authority: Signer<'info>,
}

// ── Events ────────────────────────────────────────────────────────────────────

#[event]
pub struct AgentRegistered {
    pub agent: Pubkey,
    pub authority: Pubkey,
    pub policy_authority: Pubkey,
    pub max_value_lamports: u64,
    pub allowed_actions_mask: u8,
    pub window_seconds: i64,
    pub max_per_window: u32,
}

#[event]
pub struct IntentEvaluated {
    pub agent: Pubkey,
    pub seq: u64,
    pub approved: bool,
}

#[event]
pub struct ReceiptWritten {
    pub agent: Pubkey,
    pub intent_seq: u64,
    pub value_lamports: u64,
    pub recipient: Pubkey,
    pub executed_at: i64,
}

#[event]
pub struct PolicyUpdated {
    pub agent: Pubkey,
    pub max_value_lamports: u64,
    pub allowed_actions_mask: u8,
    pub window_seconds: i64,
    pub max_per_window: u32,
}
