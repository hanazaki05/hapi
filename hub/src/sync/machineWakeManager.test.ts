import { describe, expect, it } from 'bun:test'
import type { MachineCache } from './machineCache'
import { MachineWakeManager } from './machineWakeManager'

describe('MachineWakeManager', () => {
    it('returns when the machine comes online even if the wake command is still running', async () => {
        let active = false
        const manager = new MachineWakeManager(
            new Map([
                ['machine-1', {
                    enabled: true,
                    command: 'bun -e "setTimeout(() => {}, 5000)"',
                    timeoutMs: 7_000
                }]
            ]),
            {
                getMachine() {
                    return active ? { active: true } : undefined
                }
            } as unknown as MachineCache
        )

        setTimeout(() => {
            active = true
        }, 50)

        const startedAt = Date.now()
        const result = await manager.wakeMachine('machine-1')

        expect(result).toEqual({ type: 'ok' })
        expect(Date.now() - startedAt).toBeLessThan(3_500)
    })
})
