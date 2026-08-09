#!/usr/bin/env node
import {
  isCliProviderId,
  loginCommand,
  merchantsCommand,
  sessionCommand,
  setMerchantCommand,
  setProviderCommand,
  setQrisCommand,
  setStoreCommand,
  storesCommand,
  whoamiCommand,
} from "./commands.js";
import { MerchIDError } from "../core/errors.js";

const HELP = `merchid - extensible Indonesian merchant payment CLI

Usage:
  merchid login [provider]                  Interactive OTP login
  merchid session [provider] [--reveal]     Show a masked stored session
  merchid merchants [provider]              List merchants and outlets/stores
  merchid stores [provider]                 Alias for provider outlet/store listing
  merchid whoami                            Show redacted status for all providers
  merchid set-provider <provider>            Set the default provider
  merchid set-merchant <id> [--provider id] Set the default GoPay merchant
  merchid set-store <id>                    Set the default Shopee store
  merchid set-qris [provider]                Prompt for a static QRIS securely
  merchid help                              Show this help

Providers:
  gopay, shopee

Config:
  Defaults to ~/.merchid/config.json.
  Override with MERCHID_CONFIG. The file contains credentials and must not be committed.
`;

interface ParsedArguments {
  provider?: string;
  positional: string[];
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const positional: string[] = [];
  let provider: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--provider") {
      provider = args[index + 1];
      index++;
    } else if (argument?.startsWith("--provider=")) {
      provider = argument.slice("--provider=".length);
    } else if (argument !== undefined) {
      positional.push(argument);
    }
  }
  return { provider, positional };
}

function takePositionalProvider(parsed: ParsedArguments): ParsedArguments {
  const first = parsed.positional[0];
  if (!parsed.provider && isCliProviderId(first)) {
    return { provider: first, positional: parsed.positional.slice(1) };
  }
  return parsed;
}

async function runCli(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  let parsed = parseArguments(rest);

  switch (command) {
    case "login":
      parsed = takePositionalProvider(parsed);
      await loginCommand(parsed.provider);
      return;
    case "session":
      parsed = takePositionalProvider(parsed);
      sessionCommand(parsed.provider, parsed.positional.includes("--reveal"));
      return;
    case "whoami":
      whoamiCommand();
      return;
    case "merchants":
      parsed = takePositionalProvider(parsed);
      merchantsCommand(parsed.provider);
      return;
    case "stores":
      parsed = takePositionalProvider(parsed);
      storesCommand(parsed.provider);
      return;
    case "set-provider":
      setProviderCommand(parsed.positional[0] ?? "");
      return;
    case "set-merchant":
      setMerchantCommand(parsed.positional[0] ?? "", parsed.provider);
      return;
    case "set-store":
      setStoreCommand(parsed.positional[0] ?? "");
      return;
    case "set-qris":
      parsed = takePositionalProvider(parsed);
      await setQrisCommand(parsed.provider);
      return;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(HELP);
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

export function executeCli(argv: string[]): void {
  runCli(argv).catch((error: unknown) => {
    if (error instanceof MerchIDError) {
      process.stderr.write(`Error [${error.code}]: ${error.message}\n`);
    } else if (error instanceof Error) {
      process.stderr.write(`Error: ${error.message}\n`);
    } else {
      process.stderr.write(`Error: ${String(error)}\n`);
    }
    process.exitCode = 1;
  });
}
