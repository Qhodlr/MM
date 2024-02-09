use super::*;
use solana_sdk::compute_budget::ComputeBudgetInstruction;
use solana_sdk::instruction;

#[tokio::test]
async fn test_allocator() -> Result<(), TransportError> {
    let mut test_builder = TestContextBuilder::new();
    test_builder.test().set_compute_max_units(130_000);
    let context = test_builder.start_default().await;
    let solana = &context.solana.clone();

    let goo = ComputeBudgetInstruction::request_heap_frame(1);
    let result = send_tx_with_extra_ix(solana, OverAllocInstruction {}, goo)
    .await
    .unwrap();

    result.result.unwrap();

    Ok(())
}
