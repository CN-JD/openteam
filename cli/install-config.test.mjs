import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('openteamcli install configuration', () => {
  it('exposes openteamcli as an npm bin for local global installs', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

    expect(pkg.bin).toEqual({
      openteamcli: './cli/openteamcli.mjs',
    })
    expect(pkg.files).toEqual(expect.arrayContaining(['cli', 'skills']))
  })

  it('documents the installed openteamcli command in the skill', () => {
    const skill = readFileSync(resolve(root, 'skills/SKILL.md'), 'utf8')

    expect(skill).toContain('openteamcli doctor')
    expect(skill).not.toContain('npm run openteamcli --')
  })
})
