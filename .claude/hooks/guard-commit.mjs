#!/usr/bin/env node
/**
 * PreToolUse 훅 — git commit 을 막아야 할 두 가지 경우를 검사한다.
 *
 * 1. 환경변수 파일(.env)이 스테이징된 경우
 *    Public 저장소이므로 한 번 푸시되면 히스토리에 영구히 남는다.
 *    .gitignore 가 있지만 `git add -f` 나 gitignore 수정으로 뚫릴 수 있다.
 *
 * 2. 커밋 메시지에 AI Co-Authored-By 트레일러가 있는 경우
 *    이 저장소의 방침(AGENTS.md): AI 사용은 docs/AI-USAGE.md 에서 밝힌다.
 *    트레일러는 "썼다"만 말할 뿐 "어떻게 썼는지"를 말하지 못한다.
 *
 * exit 2 = 차단. 사유는 stderr 로 모델에게 전달된다.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function readCommand() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command ?? ''
  } catch {
    return ''
  }
}

const command = readCommand()

// git commit 이 아니면 통과. (`git commit` 이 파이프/체인 중간에 있어도 잡히도록 부분 일치)
if (!/\bgit\s+(-\S+\s+|--\S+(=\S+)?\s+)*commit\b/.test(command)) process.exit(0)

// 이 저장소에 대한 커밋이 아니면 관여하지 않는다.
// 사용자 전역 설정에 등록되더라도 다른 저장소의 커밋을 막지 않게 하는 가드.
if (!targetsThisRepo(command)) process.exit(0)

function targetsThisRepo(cmd) {
  const normalize = (p) => resolve(p).replace(/\\/g, '/').toLowerCase()
  const root = normalize(ROOT)

  // 명령문에 이 저장소 경로가 명시되어 있으면 대상이 맞다 (`cd /c/study/... && git commit`)
  if (normalize(cmd.replace(/\\/g, '/')).includes(root)) return true

  // 아니면 현재 작업 디렉터리로 판단한다.
  const cwd = normalize(process.cwd())
  return cwd === root || cwd.startsWith(`${root}/`)
}

const violations = []

// --- 1. AI 트레일러 검사 ---
if (/Co-Authored-By:\s*Claude/i.test(command)) {
  violations.push(
    'AI Co-Authored-By 트레일러가 커밋 메시지에 포함되어 있습니다.\n' +
      '  이 저장소는 트레일러를 쓰지 않습니다 (AGENTS.md 참조).\n' +
      '  AI 사용은 docs/AI-USAGE.md 에서 "무엇을 맡기고 무엇을 직접 판단했는지"로 밝힙니다.',
  )
}

// --- 2. .env 스테이징 검사 ---
try {
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    // .env / .env.local / .env.production 등은 차단, .env.example 은 허용
    .filter((file) => /(^|\/)\.env(\.|$)/.test(file) && !file.endsWith('.env.example'))

  if (staged.length > 0) {
    violations.push(
      `환경변수 파일이 스테이징되어 있습니다: ${staged.join(', ')}\n` +
        '  Public 저장소입니다 — 푸시되면 히스토리에 영구히 남습니다.\n' +
        `  해제: git reset HEAD ${staged.join(' ')}`,
    )
  }
} catch {
  // git 저장소가 아니거나 명령이 실패하면 검사를 건너뛴다 (훅이 작업을 막아서는 안 된다)
}

if (violations.length === 0) process.exit(0)

console.error('커밋이 차단되었습니다.\n')
for (const violation of violations) console.error(`- ${violation}\n`)
process.exit(2)
