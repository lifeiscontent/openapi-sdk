#!/usr/bin/env node

import * as commands from './commands/index.js';

function help() {
  return [
    'Usage:',
    '\topenapi-sdk <command> <options>',
    '',
    'Commands:',
    ...Object.entries(commands).map(
      ([commandName, command]) => `\t${commandName}\t${command.description()}`
    ),
    '\thelp\tShow specific help for commands',
  ].join('\n');
}

function usage() {
  return [
    'Commands:',
    ...Object.entries(commands).map(
      ([commandName, command]) => `\t${commandName} ${command.usage()}`
    ),
  ].join('\n');
}

function getCommandName(args: string[]) {
  if (args[0] === 'help') {
    return 'usage';
  }
  if (args[0] in commands) {
    return args[0] as keyof typeof commands;
  }
}

async function main(args: string[]) {
  const command = getCommandName(args);
  if (command === 'usage') {
    console.log(usage());
  } else if (command) {
    const commandArgs = args.slice(1);
    await commands[command].execute(commandArgs);
  } else {
    console.log(help());
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exit(1);
});
