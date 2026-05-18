import { execFile } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import type { MachineCache } from './machineCache'
import type { MachineWakeHook } from '../config/serverSettings'

export type { MachineWakeHook }
export type WakeHookConfig = Map<string, MachineWakeHook>

export type WakeResult =
    | { type: 'ok' }
    | { type: 'not-configured' }
    | { type: 'disabled' }
    | { type: 'timeout'; message: string }
    | { type: 'command-failed'; message: string }

const POLL_INTERVAL_MS = 2_000

function runCommand(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = execFile(command, [], {
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024,
            shell: true
        }, (error, stdout, stderr) => {
            if (error) {
                reject(error)
            } else {
                resolve({ stdout, stderr })
            }
        })
        child.on('error', reject)
    })
}

export class MachineWakeManager {
    private readonly config: WakeHookConfig
    private readonly machineCache: MachineCache
    private readonly wakeLocks: Map<string, Promise<WakeResult>> = new Map()

    constructor(config: WakeHookConfig, machineCache: MachineCache) {
        this.config = config
        this.machineCache = machineCache
    }

    async wakeMachine(machineId: string): Promise<WakeResult> {
        const hook = this.config.get(machineId)

        if (!hook) {
            return { type: 'not-configured' }
        }

        if (!hook.enabled) {
            return { type: 'disabled' }
        }

        const existingLock = this.wakeLocks.get(machineId)
        if (existingLock) {
            return existingLock
        }

        const wakePromise = this.executeWake(machineId, hook)
        this.wakeLocks.set(machineId, wakePromise)

        try {
            return await wakePromise
        } finally {
            this.wakeLocks.delete(machineId)
        }
    }

    private async executeWake(machineId: string, hook: MachineWakeHook): Promise<WakeResult> {
        // Run wake command
        try {
            const { stdout, stderr } = await runCommand(hook.command, hook.timeoutMs)
            if (stdout) console.log(`[MachineWakeManager] wake command stdout: ${stdout.trim()}`)
            if (stderr) console.error(`[MachineWakeManager] wake command stderr: ${stderr.trim()}`)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[MachineWakeManager] wake command failed for ${machineId}: ${message}`)
            return { type: 'command-failed', message }
        }

        // Poll for machine to come online
        const deadline = Date.now() + hook.timeoutMs
        while (Date.now() < deadline) {
            const machine = this.machineCache.getMachine(machineId)
            if (machine?.active) {
                console.log(`[MachineWakeManager] machine ${machineId} is now online`)
                return { type: 'ok' }
            }
            await sleep(POLL_INTERVAL_MS)
        }

        return {
            type: 'timeout',
            message: `Machine ${machineId} did not come online within ${hook.timeoutMs}ms`
        }
    }
}
