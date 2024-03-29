use crate::error::*;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct TokenConditionalSwapStart<'info> {
    #[account(
        constraint = group.load()?.is_ix_enabled(IxGate::TokenConditionalSwapStart) @ MangoError::IxIsDisabled,
    )]
    pub group: AccountLoader<'info, Group>,

    #[account(
        mut,
        has_one = group,
        constraint = liqee.load()?.is_operational() @ MangoError::AccountIsFrozen
    )]
    pub liqee: AccountLoader<'info, MangoAccountFixed>,

    #[account(
        mut,
        has_one = group,
        constraint = liqor.load()?.is_operational() @ MangoError::AccountIsFrozen,
        constraint = liqor.load()?.is_owner_or_delegate(liqor_authority.key()),
        constraint = liqor.key() != liqee.key(),
    )]
    pub liqor: AccountLoader<'info, MangoAccountFixed>,
    pub liqor_authority: Signer<'info>,
}
