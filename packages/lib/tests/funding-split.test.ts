// The weighted split of root's NIGHT across the role wallets that need
// funding. Pure: no wallet is opened.

import { describe, expect, it } from "vitest";

import { fundingShare, perChildAmount, type RoleWallet } from "../src/wallet-funding.ts";

const DEPLOYER: RoleWallet = { label: "deployer", envVar: "DEPLOYER_SEED", shares: 3n };
const USER: RoleWallet = { label: "user", envVar: "USER_SEED", shares: 1n };
const MPC_RESPONDER: RoleWallet = {
  label: "mpc responder",
  envVar: "MPC_RESPONDER_SEED",
  shares: 1n,
};
const BEARER: RoleWallet = { label: "bearer", envVar: "BEARER_SEED", shares: 1n };

describe("fundingShare", () => {
  /** Root's balance, who still needs funding, and what one share comes to. */
  interface ShareCase {
    readonly name: string;
    readonly rootNight: bigint;
    readonly unfunded: readonly RoleWallet[];
    readonly share: bigint;
  }

  const CASES: readonly ShareCase[] = [
    {
      name: "every role unfunded: six shares for the children plus root's one",
      rootNight: 700n,
      unfunded: [DEPLOYER, USER, MPC_RESPONDER, BEARER],
      share: 100n,
    },
    {
      name: "only the deployer unfunded: its three shares plus root's one",
      rootNight: 600n,
      unfunded: [DEPLOYER],
      share: 150n,
    },
    {
      name: "nobody unfunded: root keeps its one share",
      rootNight: 600n,
      unfunded: [],
      share: 600n,
    },
    {
      name: "an uneven balance rounds the share down",
      rootNight: 601n,
      unfunded: [USER],
      share: 300n,
    },
  ];

  it.each(CASES)("$name", ({ rootNight, unfunded, share }) => {
    expect(fundingShare(rootNight, unfunded)).toBe(share);
  });
});

describe("perChildAmount", () => {
  /** The environment, the share and the child, and the NIGHT the child receives. */
  interface AmountCase {
    readonly name: string;
    readonly env: NodeJS.ProcessEnv;
    readonly share: bigint;
    readonly child: RoleWallet;
    readonly amount: bigint;
  }

  const CASES: readonly AmountCase[] = [
    {
      name: "the deployer receives three shares",
      env: {},
      share: 100n,
      child: DEPLOYER,
      amount: 300n,
    },
    { name: "the user receives one share", env: {}, share: 100n, child: USER, amount: 100n },
    {
      name: "FUND_CHILD_NIGHT pins the amount whatever the shares",
      env: { FUND_CHILD_NIGHT: "42" },
      share: 100n,
      child: DEPLOYER,
      amount: 42n,
    },
    {
      name: "a blank FUND_CHILD_NIGHT is unset",
      env: { FUND_CHILD_NIGHT: "  " },
      share: 100n,
      child: USER,
      amount: 100n,
    },
  ];

  it.each(CASES)("$name", ({ env, share, child, amount }) => {
    expect(perChildAmount(env, share, child)).toBe(amount);
  });

  it("refuses a FUND_CHILD_NIGHT that is not a non-negative integer", () => {
    expect(() => perChildAmount({ FUND_CHILD_NIGHT: "-1" }, 100n, USER)).toThrow(
      /FUND_CHILD_NIGHT must be a non-negative integer/,
    );
  });
});
