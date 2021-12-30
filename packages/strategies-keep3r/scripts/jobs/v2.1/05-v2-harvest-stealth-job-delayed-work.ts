import { run, ethers, network } from 'hardhat';
import { e18, gwei, ZERO_ADDRESS } from '../../../utils/web3-utils';
import * as contracts from '../../../utils/contracts';
import * as accounts from '../../../utils/accounts';
import { staticQuote } from '../../../../stealth-txs/scripts/watcher/tools/gasprice';

import { Contract, PopulatedTransaction, utils } from 'ethers';
import {
  FlashbotsBundleProvider,
  FlashbotsBundleResolution,
  FlashbotsTransaction,
  FlashbotsTransactionResponse,
  SimulationResponse,
} from '@flashbots/ethers-provider-bundle';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signers';
import kms from '../../../../commons/tools/kms/kms';

let blockProtection: Contract;

async function main() {
  await getWorkable();
}

function getWorkable(): Promise<void | Error> {
  return new Promise(async (resolve, reject) => {
    const [owner] = await ethers.getSigners();
    let signer = owner;
    if (owner.address != accounts.yKeeperWorker && owner.address != accounts.yKeeper) {
      console.log('on fork mode, impersonating yKeeperWorker');
      await network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [accounts.yKeeperWorker],
      });
      const yKeeperWorker: any = ethers.provider.getUncheckedSigner(accounts.yKeeperWorker) as any as SignerWithAddress;
      yKeeperWorker.address = yKeeperWorker._address;
      signer = yKeeperWorker;
    }

    console.log('using address:', signer.address);
    try {
      blockProtection = await ethers.getContractAt('BlockProtection', contracts.blockProtection.mainnet as string, signer);

      const harvestV2Keep3rStealthJob = await ethers.getContractAt(
        'HarvestV2Keep3rStealthJob',
        contracts.harvestV2Keep3rStealthJob.mainnet as string,
        signer
      );

      const strategies = await harvestV2Keep3rStealthJob.callStatic.strategies();
      // const strategies = ['0xC0176FAa0e20dFf3CB6B810aEaE64ef271B1b64b'];

      console.log('strategies:', strategies);
      for (const strategy of strategies) {
        try {
          const workableStrategy = await harvestV2Keep3rStealthJob.callStatic.workable(strategy);
          console.log(strategy, 'workable:', workableStrategy);

          if (!workableStrategy) continue;
          // checks if it's workable
          await harvestV2Keep3rStealthJob.callStatic.forceWorkUnsafe(strategy);
          const workTx = await harvestV2Keep3rStealthJob.populateTransaction.forceWorkUnsafe(strategy);

          const error = await flashBotsSendTx(workTx);

          if (error) {
            console.log('error:');
            console.log(error);
            return;
          }

          console.log('done!');
          return resolve();
        } catch (error) {
          console.log(error);
        }
      }

      resolve();
    } catch (err: any) {
      reject(`Error while force work v2 stealth strategies: ${err.message}`);
    }
    // } else {
    //   console.error('Aborted!');
    //   resolve();
    // }
    // });
  });
}

async function flashBotsSendTx(workTx: PopulatedTransaction): Promise<any> {
  const network = await ethers.provider.getNetwork();
  if (network.chainId != 1) return 'not on mainnet network. please use --network mainnet';
  const provider = ethers.provider;

  console.log('creating signer');
  const signer = new ethers.Wallet(kms.decryptSync(process.env.MAINNET_1_PRIVATE_KEY as string)).connect(provider);
  const flashbotSigner = new ethers.Wallet(kms.decryptSync(process.env.FLASHBOTS_PRIVATE_KEY as string)).connect(provider);

  // Flashbots provider requires passing in a standard provider
  console.log('creating flashbotsProvider');
  const flashbotsProvider = await FlashbotsBundleProvider.create(
    provider, // a normal ethers.js provider, to perform gas estimiations and nonce lookups
    flashbotSigner // ethers.js signer wallet, only for signing request payloads, not transactions
  );

  const blockNumber = await ethers.provider.getBlockNumber();
  const targetBlockNumber = blockNumber + 10; // 10 blocks delay

  const gasResponse = await staticQuote();
  console.log(gasResponse);
  const gasPrices = gasResponse.blockPrices[0].estimatedPrices[0];
  console.log('gasPrice:', {
    maxFeePerGas: gasPrices.maxFeePerGas,
    maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas,
  });
  const gasPrice = utils.parseUnits(gasPrices.price.toString(), 'gwei');
  const maxFeePerGas = utils.parseUnits(gasPrices.maxFeePerGas.toString(), 'gwei');
  const maxPriorityFeePerGas = utils.parseUnits(gasPrices.maxPriorityFeePerGas.toString(), 'gwei');
  console.log('gasPrice in gwei:', gasPrice.div(gwei).toNumber());

  const maxGwei = 500;
  if (gasPrice.gt(gwei.mul(maxGwei))) {
    return `gas price > ${maxGwei}gwei`;
  }

  const fairmaxPriorityFeePerGas = maxPriorityFeePerGas.mul(100 + 5).div(100);
  console.log('fairmaxPriorityFeePerGas in gwei:', fairmaxPriorityFeePerGas.div(gwei).toNumber());

  // build stealth tx
  let nonce = ethers.BigNumber.from(await signer.getTransactionCount());

  const executeTx = await blockProtection.populateTransaction.callWithBlockProtection(
    workTx.to, // address _to,
    workTx.data, // bytes memory _data,
    targetBlockNumber, // uint256 _blockNumber
    {
      nonce,
      gasPrice,
      // maxFeePerGas,
      // maxPriorityFeePerGas: fairmaxPriorityFeePerGas,
    }
  );

  const signedTransaction = await signer.signTransaction(executeTx);

  // build bundle
  const bundle = [
    {
      signedTransaction,
    },
  ];
  const signedBundle = await flashbotsProvider.signBundle(bundle);
  let simulation: SimulationResponse;
  try {
    simulation = await flashbotsProvider.simulate(signedBundle, targetBlockNumber);
  } catch (error: any) {
    if ('body' in error && 'message' in JSON.parse(error.body).error) {
      console.log('[Simulation Error] Message:', JSON.parse(error.body).error.message);
    } else {
      console.log(error);
    }
    return 'simulation error';
  }
  if ('error' in simulation) {
    return `Simulation Error: ${simulation.error.message}`;
  } else {
    console.log(`Simulation Success: ${JSON.stringify(simulation, null, 2)}`);
  }

  // TODO test with a workable strategy

  return;

  // NOTE: here you can rebalance payment using (results[0].gasPrice * gasUsed) + a % as miner bonus
  // const fairPayment = gasPrice
  //   .mul(100 + 10) // + 10%
  //   .div(100)
  //   .mul(simulation.totalGasUsed);

  const executeTxRepriced = await blockProtection.populateTransaction.callWithBlockProtection(
    workTx.to, // address _to,
    workTx.data, // bytes memory _data,
    targetBlockNumber, // uint256 _blockNumber
    {
      nonce,
      maxFeePerGas,
      maxPriorityFeePerGas: fairmaxPriorityFeePerGas,
    }
  );

  simulation = await flashbotsProvider.simulate(
    await flashbotsProvider.signBundle([
      {
        signedTransaction: await signer.signTransaction(executeTxRepriced),
      },
    ]),
    targetBlockNumber
  );
  console.log(`Simulation Success: ${JSON.stringify(simulation, null, 2)}`);

  // send bundle
  const flashbotsTransactionResponse: FlashbotsTransaction = await flashbotsProvider.sendBundle(
    [
      {
        signedTransaction: await signer.signTransaction(executeTxRepriced),
      },
    ],
    targetBlockNumber
  );

  const resolution = await (flashbotsTransactionResponse as FlashbotsTransactionResponse).wait();

  if (resolution == FlashbotsBundleResolution.BundleIncluded) {
    console.log('BundleIncluded, sucess!');
    return;
  }
  if (resolution == FlashbotsBundleResolution.BlockPassedWithoutInclusion) {
    console.log('BlockPassedWithoutInclusion, re-build and re-send bundle...');
    return await flashBotsSendTx(workTx);
  }
  if (resolution == FlashbotsBundleResolution.AccountNonceTooHigh) {
    return 'AccountNonceTooHigh, adjust nonce';
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
