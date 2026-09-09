'use strict';

// Deterministic Codex CLI stand-in used only by the headless real-app suite.
// It exercises AhkLLM's actual codex-cli subprocess transport: --version,
// login status, stdin transcript delivery, JSONL polling, output-last-message,
// search flags, cancellation, and multiple sequential exec turns.
const fs = require('node:fs');

const args = process.argv.slice(2);
const logFile = process.env.FAKE_CODEX_LOG || '';

function append(entry) {
  if (!logFile) return;
  fs.appendFileSync(logFile, JSON.stringify(Object.assign({ at: Date.now() }, entry)) + '\n', 'utf8');
}

function configValue(prefix) {
  const arg = args.find((value) => String(value).startsWith(prefix + '='));
  if (!arg) return '';
  const raw = String(arg).slice(prefix.length + 1);
  try { return JSON.parse(raw); } catch { return raw.replace(/^"|"$/g, ''); }
}

function outputLastMessagePath() {
  const index = args.indexOf('--output-last-message');
  return index >= 0 && args[index + 1] ? args[index + 1] : '';
}

function emit(event, newline = true) {
  process.stdout.write(JSON.stringify(event) + (newline ? '\n' : ''));
}

if (args.length === 1 && args[0] === '--version') {
  append({ kind: 'version', args });
  process.stdout.write('codex-cli 0.153.4\n');
  process.exit(0);
}

if (args[0] === 'login' && args[1] === 'status') {
  append({ kind: 'login-status', args });
  process.stdout.write('Logged in using ChatGPT\n');
  process.exit(0);
}

if (args.indexOf('exec') < 0) {
  append({ kind: 'unexpected', args });
  process.stderr.write('fake Codex expected exec\n');
  process.exit(7);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const instructionPath = configValue('model_instructions_file');
  let instructions = '';
  try { instructions = instructionPath ? fs.readFileSync(instructionPath, 'utf8') : ''; } catch {}
  const outputFile = outputLastMessagePath();
  const webSearchMode = configValue('web_search');
  const reasoningEffort = configValue('model_reasoning_effort');
  const reasoningSummary = configValue('model_reasoning_summary');
  append({
    kind: 'exec',
    pid: process.pid,
    args,
    stdin: input,
    instructions,
    webSearchMode,
    reasoningEffort,
    reasoningSummary
  });

  let lastUserContent = '';
  for (const line of input.split(/\r?\n/).filter(Boolean)) {
    try {
      const message = JSON.parse(line);
      if (message && message.role === 'user') lastUserContent = String(message.content || '');
    } catch {}
  }
  const lower = lastUserContent.toLowerCase();
  const cancelMode = lower.includes('cancel this codex request');
  const slowThreadMode = lower.includes('slow thread a');
  const searchMode = lower.includes('search on codex');
  const noSearchMode = lower.includes('search off codex');
  const secondTurnMode = lower.includes('second codex turn');

  const publicSummary = secondTurnMode
    ? '**Using the prior AhkLLM transcript**'
    : searchMode
      ? '**Checking the requested current information**'
      : slowThreadMode
        ? '**Working on the originating thread**'
        : cancelMode
          ? '**Beginning a cancellable Codex response**'
          : '**Comparing the requested information**';

  setTimeout(() => {
    emit({ type: 'item.completed', item: { id: 'reasoning-1', type: 'reasoning', text: publicSummary } });

    if (cancelMode) {
      // Keep the real child process alive until AhkLLM's Stop path kills the
      // cmd.exe process tree. No output-last-message is written on purpose.
      setInterval(() => {}, 1000);
      return;
    }

    const complete = () => {
      const answer = secondTurnMode
        ? 'SECOND CODEX ANSWER'
        : slowThreadMode
          ? 'THREAD A CODEX ANSWER'
          : searchMode
            ? 'SEARCH ON CODEX ANSWER'
            : noSearchMode
              ? 'SEARCH OFF CODEX ANSWER'
              : 'BASIC CODEX ANSWER';
      emit({ type: 'item.completed', item: { id: 'final-1', type: 'agent_message', text: answer } });
      if (!outputFile) {
        process.stderr.write('missing --output-last-message\n');
        process.exitCode = 9;
        return;
      }
      fs.writeFileSync(outputFile, answer + '\n', 'utf8');
      // Deliberately omit the trailing newline so the transport's post-exit
      // drain is exercised by every headless Codex scenario.
      emit({
        type: 'turn.completed',
        usage: {
          input_tokens: secondTurnMode ? 44 : 21,
          output_tokens: 8,
          cached_input_tokens: secondTurnMode ? 21 : 0,
          total_tokens: secondTurnMode ? 52 : 29
        }
      }, false);
    };

    if (searchMode) {
      setTimeout(() => {
        emit({ type: 'item.started', item: { id: 'search-1', type: 'web_search' } });
        setTimeout(() => {
          emit({ type: 'item.completed', item: { id: 'search-1', type: 'web_search', query: 'fake current release' } });
          setTimeout(complete, 220);
        }, 180);
      }, 180);
      return;
    }

    setTimeout(complete, slowThreadMode ? 1300 : 550);
  }, 180);
});
