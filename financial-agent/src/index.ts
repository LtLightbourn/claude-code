import * as readline from "readline";
import Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "./agent.js";

const WELCOME = `
╔═══════════════════════════════════════════════════════════╗
║         Financial Research, Planning & Advice Agent       ║
║                    Powered by Claude                      ║
╠═══════════════════════════════════════════════════════════╣
║  I can help you with:                                     ║
║  • Market research & stock analysis                       ║
║  • Retirement & investment planning                       ║
║  • Budget & debt management                               ║
║  • Portfolio analysis & rebalancing                       ║
║  • Financial calculations & projections                   ║
║                                                           ║
║  Type 'quit' or 'exit' to end the session.               ║
║  Type 'clear' to start a new conversation.               ║
╚═══════════════════════════════════════════════════════════╝

Disclaimer: This agent provides general financial information and education.
For personalized legal, tax, or investment advice, consult a licensed professional.
`;

async function main() {
  console.log(WELCOME);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  let conversationHistory: Anthropic.MessageParam[] = [];
  let isProcessing = false;

  const prompt = () => {
    if (!isProcessing) {
      process.stdout.write("\nYou: ");
    }
  };

  prompt();

  for await (const line of rl) {
    const userInput = line.trim();

    if (!userInput) {
      prompt();
      continue;
    }

    if (userInput.toLowerCase() === "quit" || userInput.toLowerCase() === "exit") {
      console.log("\nGoodbye! Good luck with your financial journey.\n");
      break;
    }

    if (userInput.toLowerCase() === "clear") {
      conversationHistory = [];
      console.log("\n[Conversation cleared. Starting fresh.]\n");
      prompt();
      continue;
    }

    isProcessing = true;
    process.stdout.write("\nAssistant: ");

    try {
      conversationHistory = await runAgent(
        userInput,
        conversationHistory,
        (delta) => {
          process.stdout.write(delta);
        },
      );
      process.stdout.write("\n");
    } catch (err) {
      if (err instanceof Error) {
        console.error(`\n[Error: ${err.message}]\n`);
      } else {
        console.error("\n[An unknown error occurred]\n");
      }
    }

    isProcessing = false;
    prompt();
  }

  rl.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
