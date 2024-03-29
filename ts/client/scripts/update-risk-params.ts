import {
  LISTING_PRESETS,
  LISTING_PRESETS_PYTH,
  MidPriceImpact,
  getMidPriceImpacts,
  getProposedTier,
} from '@blockworks-foundation/mango-v4-settings/lib/helpers/listingTools';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { BN } from '@project-serum/anchor';
import {
  getAllProposals,
  getTokenOwnerRecord,
  getTokenOwnerRecordAddress,
} from '@solana/spl-governance';
import {
  AccountMeta,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import fs from 'fs';
import { OracleProvider } from '../src/accounts/oracle';
import { Builder } from '../src/builder';
import { MangoClient } from '../src/client';
import { NullTokenEditParams } from '../src/clientIxParamBuilder';
import { MANGO_V4_MAIN_GROUP as MANGO_V4_PRIMARY_GROUP } from '../src/constants';
import { toUiDecimalsForQuote } from '../src/utils';
import {
  MANGO_DAO_WALLET_GOVERNANCE,
  MANGO_GOVERNANCE_PROGRAM,
  MANGO_MINT,
  MANGO_REALM_PK,
} from './governanceInstructions/constants';
import { createProposal } from './governanceInstructions/createProposal';
import {
  DEFAULT_VSR_ID,
  VsrClient,
} from './governanceInstructions/voteStakeRegistryClient';

const {
  MB_CLUSTER_URL,
  PROPOSAL_TITLE,
  VSR_DELEGATE_KEYPAIR,
  VSR_DELEGATE_FROM_PK,
  DRY_RUN,
} = process.env;

const getApiTokenName = (bankName: string) => {
  if (bankName === 'ETH (Portal)') {
    return 'ETH';
  }
  return bankName;
};

async function buildClient(): Promise<MangoClient> {
  return await MangoClient.connectDefault(MB_CLUSTER_URL!);
}

async function setupWallet(): Promise<Wallet> {
  const clientKeypair = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(VSR_DELEGATE_KEYPAIR!, 'utf-8'))),
  );
  const clientWallet = new Wallet(clientKeypair);

  return clientWallet;
}

async function setupVsr(
  connection: Connection,
  clientWallet: Wallet,
): Promise<VsrClient> {
  const options = AnchorProvider.defaultOptions();
  const provider = new AnchorProvider(connection, clientWallet, options);
  const vsrClient = await VsrClient.connect(provider, DEFAULT_VSR_ID);
  return vsrClient;
}

async function updateTokenParams(): Promise<void> {
  const [client, wallet] = await Promise.all([buildClient(), setupWallet()]);
  const vsrClient = await setupVsr(client.connection, wallet);

  const group = await client.getGroup(MANGO_V4_PRIMARY_GROUP);

  const instructions: TransactionInstruction[] = [];
  const midPriceImpacts = getMidPriceImpacts(group.pis);

  Array.from(group.banksMapByTokenIndex.values())
    .map((banks) => banks[0])
    .filter(
      (bank) =>
        bank.mint.toBase58() == 'So11111111111111111111111111111111111111112' ||
        bank.name.toLocaleLowerCase().indexOf('usdc') > -1 ||
        bank.name.toLocaleLowerCase().indexOf('stsol') > -1,
    )
    .forEach(async (bank) => {
      // Limit borrows to 1/3rd of deposit, rounded to 1000, only update if more than 10% different
      const depositsInUsd = bank.nativeDeposits().mul(bank.price);
      let newNetBorrowLimitPerWindowQuote: number | null =
        depositsInUsd.toNumber() / 3;
      newNetBorrowLimitPerWindowQuote =
        Math.round(newNetBorrowLimitPerWindowQuote / 1_000_000_000) *
        1_000_000_000;
      newNetBorrowLimitPerWindowQuote =
        Math.abs(
          (newNetBorrowLimitPerWindowQuote -
            bank.netBorrowLimitPerWindowQuote.toNumber()) /
            bank.netBorrowLimitPerWindowQuote.toNumber(),
        ) > 0.1
          ? newNetBorrowLimitPerWindowQuote
          : null;

      // Kick in weight scaling as late as possible until liquidation fee remains reasonable
      // Only update if more than 10% different
      let newWeightScaleQuote: number | null = null;
      if (
        bank.tokenIndex != 0 && // USDC
        bank.mint.toBase58() != 'So11111111111111111111111111111111111111112' // SOL
      ) {
        const PRESETS =
          bank?.oracleProvider === OracleProvider.Pyth
            ? LISTING_PRESETS_PYTH
            : LISTING_PRESETS;

        const tokenToPriceImpact = midPriceImpacts
          .filter((x) => x.avg_price_impact_percent < 1)
          .reduce(
            (acc: { [key: string]: MidPriceImpact }, val: MidPriceImpact) => {
              if (
                !acc[val.symbol] ||
                val.target_amount > acc[val.symbol].target_amount
              ) {
                acc[val.symbol] = val;
              }
              return acc;
            },
            {},
          );
        const priceImpact = tokenToPriceImpact[getApiTokenName(bank.name)];
        const suggestedTier = getProposedTier(
          PRESETS,
          priceImpact?.target_amount,
          bank.oracleProvider === OracleProvider.Pyth,
        );
        newWeightScaleQuote =
          PRESETS[suggestedTier].borrowWeightScaleStartQuote;

        newWeightScaleQuote =
          bank.depositWeightScaleStartQuote !== newWeightScaleQuote ||
          bank.borrowWeightScaleStartQuote !== newWeightScaleQuote
            ? newWeightScaleQuote
            : null;
      }

      if (
        newNetBorrowLimitPerWindowQuote == null &&
        newWeightScaleQuote == null
      ) {
        return;
      }

      const params = Builder(NullTokenEditParams)
        .netBorrowLimitPerWindowQuote(newNetBorrowLimitPerWindowQuote)
        .borrowWeightScaleStartQuote(newWeightScaleQuote)
        .depositWeightScaleStartQuote(newWeightScaleQuote)
        .build();

      const ix = await client.program.methods
        .tokenEdit(
          params.oracle,
          params.oracleConfig,
          params.groupInsuranceFund,
          params.interestRateParams,
          params.loanFeeRate,
          params.loanOriginationFeeRate,
          params.maintAssetWeight,
          params.initAssetWeight,
          params.maintLiabWeight,
          params.initLiabWeight,
          params.liquidationFee,
          params.stablePriceDelayIntervalSeconds,
          params.stablePriceDelayGrowthLimit,
          params.stablePriceGrowthLimit,
          params.minVaultToDepositsRatio,
          params.netBorrowLimitPerWindowQuote !== null
            ? new BN(params.netBorrowLimitPerWindowQuote)
            : null,
          params.netBorrowLimitWindowSizeTs !== null
            ? new BN(params.netBorrowLimitWindowSizeTs)
            : null,
          params.borrowWeightScaleStartQuote,
          params.depositWeightScaleStartQuote,
          params.resetStablePrice ?? false,
          params.resetNetBorrowLimit ?? false,
          params.reduceOnly,
          params.name,
          params.forceClose,
          params.tokenConditionalSwapTakerFeeRate,
          params.tokenConditionalSwapMakerFeeRate,
          params.flashLoanDepositFeeRate,
        )
        .accounts({
          group: group.publicKey,
          oracle: bank.oracle,
          admin: group.admin,
          mintInfo: group.mintInfosMapByTokenIndex.get(bank.tokenIndex)
            ?.publicKey,
        })
        .remainingAccounts([
          {
            pubkey: bank.publicKey,
            isWritable: true,
            isSigner: false,
          } as AccountMeta,
        ])
        .instruction();

      const tx = new Transaction({ feePayer: wallet.publicKey }).add(ix);
      const simulated = await client.connection.simulateTransaction(tx);

      if (simulated.value.err) {
        console.log('error', simulated.value.logs);
        throw simulated.value.logs;
      }

      console.log(`Bank ${bank.name}`);
      console.log(
        `- netBorrowLimitPerWindowQuote UI old ${toUiDecimalsForQuote(
          bank.netBorrowLimitPerWindowQuote.toNumber(),
        ).toLocaleString()} new ${toUiDecimalsForQuote(
          newNetBorrowLimitPerWindowQuote!,
        ).toLocaleString()}`,
      );
      console.log(
        `- WeightScaleQuote UI old ${toUiDecimalsForQuote(
          bank.depositWeightScaleStartQuote,
        ).toLocaleString()} new ${toUiDecimalsForQuote(
          newWeightScaleQuote!,
        ).toLocaleString()}`,
      );
      instructions.push(ix);
    });

  const tokenOwnerRecordPk = await getTokenOwnerRecordAddress(
    MANGO_GOVERNANCE_PROGRAM,
    MANGO_REALM_PK,
    MANGO_MINT,
    new PublicKey(VSR_DELEGATE_FROM_PK!),
  );

  const [tokenOwnerRecord, proposals] = await Promise.all([
    getTokenOwnerRecord(client.connection, tokenOwnerRecordPk),
    getAllProposals(
      client.connection,
      MANGO_GOVERNANCE_PROGRAM,
      MANGO_REALM_PK,
    ),
  ]);

  const walletSigner = wallet as never;

  if (!DRY_RUN) {
    const proposalAddress = await createProposal(
      client.connection,
      walletSigner,
      MANGO_DAO_WALLET_GOVERNANCE,
      tokenOwnerRecord,
      PROPOSAL_TITLE ? PROPOSAL_TITLE : 'Update risk parameters for tokens',
      '',
      Object.values(proposals).length,
      instructions,
      vsrClient!,
    );
    console.log(proposalAddress.toBase58());
  }
}

async function main(): Promise<void> {
  try {
    await updateTokenParams();
  } catch (error) {
    console.log(error);
  }
}

try {
  main();
} catch (error) {
  console.log(error);
}
