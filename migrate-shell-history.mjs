#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import os from 'os';

// Default file paths
const zshHistoryPath = path.join(os.homedir(), '.zsh_history');
const fishHistoryPath = path.join(os.homedir(), '.local/share/fish/fish_history');


// Function to parse zsh history
async function parseZshHistory(filePath) {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  const commands = [];

  // Regular expression to match zsh history entries
  // Format: : 1234567890:0;command
  const zshHistoryRegex = /^: (\d+):0;(.*)$/;

  for await (const line of rl) {
    const match = line.match(zshHistoryRegex);
    if (match) {
      const timestamp = parseInt(match[1], 10);
      const command = match[2];

      // Skip empty commands
      if (command.trim()) {
        commands.push({
          command: command,
          timestamp: timestamp
        });
      }
    }
  }

  return commands;
}

// Function to create fish history entry
function createFishHistoryEntry(command, timestamp) {
  const entry = {
    cmd: command,
    when: timestamp
  };

  return `- cmd: ${entry.cmd}\n  when: ${entry.when}\n`;
}

// Function to write fish history
function writeFishHistory(filePath, commands) {
  // Create directory if it doesn't exist
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Create fish history format
  let fishHistory = '';
  commands.forEach(cmd => {
    fishHistory += createFishHistoryEntry(cmd.command, cmd.timestamp);
  });

  // Write to file
  fs.writeFileSync(filePath, fishHistory);
}

// Main function
async function main() {
  try {
    console.log(`Reading zsh history from: ${zshHistoryPath}`);

    if (!fs.existsSync(zshHistoryPath)) {
      throw new Error(`ZSH history file not found at: ${zshHistoryPath}`);
    }

    const commands = await parseZshHistory(zshHistoryPath);
    console.log(`Found ${commands.length} commands in zsh history`);

    console.log(`Writing fish history to: ${fishHistoryPath}`);
    writeFishHistory(fishHistoryPath, commands);

    console.log('Conversion completed successfully!');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
