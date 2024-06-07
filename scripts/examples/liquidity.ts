import { ethers } from "hardhat";

import { CurrencyAmount, Percent, Token } from "@uniswap/sdk-core";
import { computePoolAddress, MintOptions, nearestUsableTick, Pool, Position } from "@uniswap/v3-sdk";

import { UniswapV3Pool__factory, NonfungiblePositionManager__factory, ERC20__factory } from "./bindings";

import { CurrentConfig, initPoolCodeHash } from "./config/uni-config";

import { encodePriceSqrt, fromReadableAmount } from "./conversion";
import { getTokenTransferApproval } from "./utils";

interface PoolInfo {
  token0: string;
  token1: string;
  fee: number;
  tickSpacing: number;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
}

export async function getPoolInfo(factoryAddress: string): Promise<PoolInfo> {
  const signer = await ethers.provider.getSigner();

  const currentPoolAddress = computePoolAddress({
    factoryAddress: factoryAddress,
    tokenA: CurrentConfig.tokens.token0,
    tokenB: CurrentConfig.tokens.token1,
    fee: CurrentConfig.tokens.poolFee,
    initCodeHashManualOverride: initPoolCodeHash,
  });

  const poolContract = UniswapV3Pool__factory.connect(currentPoolAddress, signer as any);

  const beforeSlot0 = await poolContract.slot0();

  if (beforeSlot0.sqrtPriceX96 == 0n) {
    await poolContract.initialize(encodePriceSqrt(1, 1));
    console.log("Pool initialized");
  }

  const [token0, token1, fee, tickSpacing, liquidity, slot0] = await Promise.all([
    poolContract.token0(),
    poolContract.token1(),
    poolContract.fee(),
    poolContract.tickSpacing(),
    poolContract.liquidity(),
    poolContract.slot0(),
  ]);

  return {
    token0,
    token1,
    fee: Number(fee),
    tickSpacing: Number(tickSpacing),
    liquidity,
    sqrtPriceX96: slot0[0],
    tick: Number(slot0[1]),
  };
}

export async function constructPosition(
  token0Amount: CurrencyAmount<Token>,
  token1Amount: CurrencyAmount<Token>,
): Promise<Position> {
  // get pool info
  const poolInfo = await getPoolInfo(CurrentConfig.factoryAddress);

  console.log(
    token0Amount.currency,
    token1Amount.currency,
    poolInfo.fee,
    poolInfo.sqrtPriceX96.toString(),
    poolInfo.liquidity.toString(),
    poolInfo.tick,
  );

  // construct pool instance
  const configuredPool = new Pool(
    token0Amount.currency,
    token1Amount.currency,
    poolInfo.fee,
    poolInfo.sqrtPriceX96.toString(),
    poolInfo.liquidity.toString(),
    poolInfo.tick,
  );

  // create position using the maximum liquidity from input amounts
  return Position.fromAmounts({
    pool: configuredPool,
    tickLower: nearestUsableTick(poolInfo.tick, poolInfo.tickSpacing) - poolInfo.tickSpacing * 2,
    tickUpper: nearestUsableTick(poolInfo.tick, poolInfo.tickSpacing) + poolInfo.tickSpacing * 2,
    amount0: token0Amount.quotient,
    amount1: token1Amount.quotient,
    useFullPrecision: true,
  });
}

export async function mintPosition(): Promise<any | null> {
  const signer = await ethers.provider.getSigner();

  // Give approval to the contract to transfer tokens
  const tokenInApproval = await getTokenTransferApproval(CurrentConfig.managerAddress, CurrentConfig.tokens.token0);
  const tokenOutApproval = await getTokenTransferApproval(CurrentConfig.managerAddress, CurrentConfig.tokens.token1);

  console.assert(tokenInApproval, "TokenIn approval failed");
  console.assert(tokenOutApproval, "TokenOut approval failed");

  console.log("Approvals successful");

  const positionToMint = await constructPosition(
    CurrencyAmount.fromRawAmount(
      CurrentConfig.tokens.token0,
      fromReadableAmount(CurrentConfig.tokens.token0Amount, CurrentConfig.tokens.token0.decimals).toString(),
    ),
    CurrencyAmount.fromRawAmount(
      CurrentConfig.tokens.token1,
      fromReadableAmount(CurrentConfig.tokens.token1Amount, CurrentConfig.tokens.token1.decimals).toString(),
    ),
  );

  console.log("Position constructed");

  const mintOptions: MintOptions = {
    recipient: signer.address,
    deadline: Math.floor(Date.now() / 1000) + 60 * 20,
    slippageTolerance: new Percent(50, 10_000),
  };

  const manager = NonfungiblePositionManager__factory.connect(CurrentConfig.managerAddress, signer);

  let _position$mintAmounts = positionToMint.mintAmounts,
    amount0Desired = _position$mintAmounts.amount0.toString(),
    amount1Desired = _position$mintAmounts.amount1.toString();

  let minimumAmounts = positionToMint.mintAmountsWithSlippage(mintOptions.slippageTolerance);
  let amount0Min = ethers.toBeHex(minimumAmounts.amount0.toString(), 32);
  let amount1Min = ethers.toBeHex(minimumAmounts.amount1.toString(), 32);

  console.log({
    token0: positionToMint.pool.token0.address,
    token1: positionToMint.pool.token1.address,
    fee: positionToMint.pool.fee,
    tickLower: positionToMint.tickLower,
    tickUpper: positionToMint.tickUpper,
    amount0Desired: BigInt(ethers.toBeHex(amount0Desired, 32)),
    amount1Desired: BigInt(ethers.toBeHex(amount1Desired, 32)),
    amount0Min: amount0Min,
    amount1Min: amount1Min,
    recipient: mintOptions.recipient,
    deadline: ethers.toBeHex(mintOptions.deadline.toString(), 32),
  });

  return (
    await manager.mint({
      token0: positionToMint.pool.token0.address,
      token1: positionToMint.pool.token1.address,
      fee: positionToMint.pool.fee,
      tickLower: positionToMint.tickLower,
      tickUpper: positionToMint.tickUpper,
      amount0Desired: ethers.toBeHex(amount0Desired, 32),
      amount1Desired: ethers.toBeHex(amount1Desired, 32),
      amount0Min: amount0Min,
      amount1Min: amount1Min,
      recipient: mintOptions.recipient,
      deadline: ethers.toBeHex(mintOptions.deadline.toString(), 32),
    })
  ).wait();
}

export async function addLiquidity(): Promise<void> {
  const receipt = await mintPosition();

  console.log(receipt);
}

addLiquidity()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
