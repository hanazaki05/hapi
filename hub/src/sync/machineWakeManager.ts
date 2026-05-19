import { spawn } from 'node:child_process'
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

interface WakeCommandProcess {
    exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>
    stop: () => void
}

function appendWithLimit(current: string, chunk: Buffer): string {
    const next = current + chunk.toString()
    return next.length > 1024 * 1024 ? next.slice(-1024 * 1024) : next
}

function startCommand(command: string, onOutput: (output: { stdout: string; stderr: string }) => void): WakeCommandProcess {
    let stdout = ''
    let stderr = ''

    const child = spawn(command, [], {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe']
    })

    child.stdout.on('data', (chunk: Buffer) => {
        stdout = appendWithLimit(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
        stderr = appendWithLimit(stderr, chunk)
    })

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
        child.once('error', (error) => {
            onOutput({ stdout, stderr })
            resolve({ code: null, signal: null, error })
        })
        child.once('exit', (code, signal) => {
            onOutput({ stdout, stderr })
            resolve({ code, signal })
        })
    })

    return {
        exit,
        stop: () => {
            if (!child.killed && child.exitCode === null) {
                child.kill('SIGTERM')
            }
        }
    }
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
        const logOutput = ({ stdout, stderr }: { stdout: string; stderr: string }) => {
            if (stdout) console.log(`[MachineWakeManager] wake command stdout: ${stdout.trim()}`)
            if (stderr) console.error(`[MachineWakeManager] wake command stderr: ${stderr.trim()}`)
        }

        const deadline = Date.now() + hook.timeoutMs
        const command = startCommand(hook.command, logOutput)
        let commandFinished: Awaited<WakeCommandProcess['exit']> | null = null

        while (Date.now() < deadline) {
            const machine = this.machineCache.getMachine(machineId)
            if (machine?.active) {
                console.log(`[MachineWakeManager] machine ${machineId} is now online`)
                return { type: 'ok' }
            }

            if (!commandFinished) {
                const pollDelayMs = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()))
                const result = await Promise.race([
                    command.exit.then(exit => ({ type: 'exit' as const, exit })),
                    sleep(pollDelayMs).then(() => ({ type: 'poll' as const }))
                ])

                if (result.type === 'exit') {
                    commandFinished = result.exit
                    if (commandFinished.error) {
                        const message = commandFinished.error.message
                        console.error(`[MachineWakeManager] wake command failed for ${machineId}: ${message}`)
                        return { type: 'command-failed', message }
                    }

                    if (commandFinished.code !== 0) {
                        const message = `Wake command exited with code ${commandFinished.code ?? 'null'}${commandFinished.signal ? ` signal ${commandFinished.signal}` : ''}`
                        console.error(`[MachineWakeManager] wake command failed for ${machineId}: ${message}`)
                        return { type: 'command-failed', message }
                    }
                }
            } else {
                await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())))
            }
        }

        command.stop()
        return {
            type: 'timeout',
            message: `Machine ${machineId} did not come online within ${hook.timeoutMs}ms`
        }
    }
}
