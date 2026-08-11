#!/usr/bin/env node
/**
 * PostToolUse 훅 — .ts 파일을 수정한 직후 타입체크를 돌린다.
 *
 * 왜 필요한가: 에이전트가 TypeScript 를 연속으로 작성할 때 타입 오류가 조용히 누적된다.
 * 마지막에 한 번에 터지면 어느 변경이 원인인지 찾기 어렵다. 쓰는 즉시 잡는다.
 *
 * 실패 시 exit 2 로 종료하면 오류 내용이 모델에게 되돌아간다.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function readTargetPath() {
  try {
    const payload = JSON.parse(readFileSync(0, 'utf8'))
    return payload?.tool_input?.file_path ?? payload?.tool_response?.filePath ?? ''
  } catch {
    return ''
  }
}

const target = readTargetPath()

// TypeScript 파일이 아니면 아무것도 하지 않는다.
if (!target.endsWith('.ts') && !target.endsWith('.tsx')) process.exit(0)

try {
  execFileSync('npm', ['run', 'typecheck', '--silent'], {
    cwd: ROOT,
    stdio: 'pipe',
    shell: true, // Windows 에서 npm 은 npm.cmd 라 shell 이 필요하다
    encoding: 'utf8',
  })
  process.exit(0)
} catch (error) {
  const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  const errorLines = output
    .split('\n')
    .filter((line) => line.includes('error TS'))
    .slice(0, 10)

  console.error('타입체크 실패 — 계속 진행하기 전에 수정하세요:')
  console.error(errorLines.length > 0 ? errorLines.join('\n') : output.slice(0, 2000))
  process.exit(2)
}
