use anchor_lang::prelude::*;

use openbook_v2::cpi::accounts::CloseOpenOrdersAccount;

use crate::accounts_ix::*;
use crate::error::MangoError;
use crate::state::*;

pub fn openbook_v2_close_open_orders(ctx: Context<OpenbookV2CloseOpenOrders>) -> Result<()> {
    //
    // Validation
    //
    let mut account = ctx.accounts.account.load_full_mut()?;
    // account constraint #1
    require!(
        account
            .fixed
            .is_owner_or_delegate(ctx.accounts.authority.key()),
        MangoError::SomeError
    );

    let openbook_market = ctx.accounts.openbook_v2_market.load()?;

    // Validate open_orders #2
    require!(
        account
            .openbook_v2_orders(openbook_market.market_index)?
            .open_orders
            == ctx.accounts.open_orders_account.key(),
        MangoError::SomeError
    );

    //
    // close OO
    //
    let account_seeds = mango_account_seeds!(account.fixed);
    cpi_close_open_orders(ctx.accounts, &[account_seeds])?;

    // Reduce the in_use_count on the token positions - they no longer need to be forced open.
    // We cannot immediately dust tiny positions because we don't have the banks.
    let (base_position, _) = account.token_position_mut(openbook_market.base_token_index)?;
    base_position.decrement_in_use();
    let (quote_position, _) = account.token_position_mut(openbook_market.quote_token_index)?;
    quote_position.decrement_in_use();

    // Deactivate the open orders account itself
    account.deactivate_openbook_v2_orders(openbook_market.market_index)?;

    Ok(())
}

fn cpi_close_open_orders(ctx: &OpenbookV2CloseOpenOrders, seeds: &[&[&[u8]]]) -> Result<()> {
    // todo-pan: when do we clean up the indexer? new ix? can we tell here if nothing else is using it?
    let group = ctx.group.load()?;
    let cpi_accounts = CloseOpenOrdersAccount {
        payer: ctx.authority.to_account_info(),
        owner: ctx.account.to_account_info(),
        open_orders_indexer: ctx.open_orders_indexer.to_account_info(),
        open_orders_account: ctx.open_orders_account.to_account_info(),
        sol_destination: ctx.authority.to_account_info(),
        system_program: ctx.system_program.to_account_info(),
    };

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.openbook_v2_program.to_account_info(),
        cpi_accounts,
        seeds,
    );

    openbook_v2::cpi::close_open_orders_account(cpi_ctx)
}
