use solana_client::{
    client_error::Result as ClientResult, rpc_client::RpcClient, rpc_request::RpcError,
};
use solana_sdk::transaction::Transaction;
use solana_sdk::{
    clock::Slot,
    commitment_config::CommitmentConfig,
    signature::{Keypair, Signature},
    transaction::uses_durable_nonce,
};

use std::{thread, time};

// #[allow(dead_code)]
// pub fn retry<T>(request: impl Fn() -> Result<T, anchor_client::ClientError>) -> anyhow::Result<T> {
//     for _i in 0..5 {
//         match request() {
//             Ok(res) => return Ok(res),
//             Err(err) => {
//                 // TODO: only retry for recoverable errors
//                 log::error!("{:#?}", err);
//                 continue;
//             }
//         }
//     }
//     Err(anyhow!("Retry failed"))
// }

pub trait MyClone {
    fn clone(&self) -> Self;
}

impl MyClone for Keypair {
    fn clone(&self) -> Keypair {
        Self::from_bytes(&self.to_bytes()).unwrap()
    }
}

/// A copy of RpcClient::send_and_confirm_transaction that returns the slot the
/// transaction confirmed in.
pub fn send_and_confirm_transaction(
    rpc_client: &RpcClient,
    transaction: &Transaction,
) -> ClientResult<(Signature, Slot)> {
    const SEND_RETRIES: usize = 1;
    const GET_STATUS_RETRIES: usize = usize::MAX;

    'sending: for _ in 0..SEND_RETRIES {
        let signature = rpc_client.send_transaction(transaction)?;

        let recent_blockhash = if uses_durable_nonce(transaction).is_some() {
            let (recent_blockhash, ..) =
                rpc_client.get_latest_blockhash_with_commitment(CommitmentConfig::processed())?;
            recent_blockhash
        } else {
            transaction.message.recent_blockhash
        };

        for status_retry in 0..GET_STATUS_RETRIES {
            let response = rpc_client.get_signature_statuses(&[signature])?.value;
            match response[0]
                .clone()
                .filter(|result| result.satisfies_commitment(rpc_client.commitment()))
            {
                Some(tx_status) => {
                    return if let Some(e) = tx_status.err {
                        Err(e.into())
                    } else {
                        Ok((signature, tx_status.slot))
                    };
                }
                None => {
                    if !rpc_client
                        .is_blockhash_valid(&recent_blockhash, CommitmentConfig::processed())?
                    {
                        // Block hash is not found by some reason
                        break 'sending;
                    } else if cfg!(not(test))
                        // Ignore sleep at last step.
                        && status_retry < GET_STATUS_RETRIES
                    {
                        // Retry twice a second
                        thread::sleep(time::Duration::from_millis(500));
                        continue;
                    }
                }
            }
        }
    }

    Err(RpcError::ForUser(
        "unable to confirm transaction. \
            This can happen in situations such as transaction expiration \
            and insufficient fee-payer funds"
            .to_string(),
    )
    .into())
}