const ChildProcess = require('child_process')
const { crossPlatformKillProcessIfValid } = require('./processHandler')
let processLimiterDatabase = {}
let ongoingProcesses = []

/**
 * Will freeze until any currently running processes are done
 *
 * Returns at function, which when called, will let the next in line through
 * @param {string} processName Name of current process. Eg. "sceneDetection"
 */
async function yourTurn (processName) {
  if (!processLimiterDatabase[processName]) {
    processLimiterDatabase[processName] = []
  }
  let resolveMe
  return new Promise((resolve) => {
    resolveMe = resolve
    let listIsEmpty = processLimiterDatabase[processName].length === 0
    processLimiterDatabase[processName].push(resolveMe)
    if (listIsEmpty) {
      resolveMe()
    }
  })
    .then(() => {
      return () => {
        if (!processLimiterDatabase[processName]) {
          processLimiterDatabase[processName] = []
        }
        let indexOfResolveMe = processLimiterDatabase[processName].indexOf(resolveMe)
        if (indexOfResolveMe !== -1) {
          processLimiterDatabase[processName].splice(indexOfResolveMe, 1)
        }

        if (processLimiterDatabase[processName].length > 0) {
          let nextResolve = processLimiterDatabase[processName].shift()
          if (typeof nextResolve === 'function') {
            nextResolve()
          }
        }
      }
    })
}

/**
 * Kill all currently running processes, and remove everything from the queues
 *
 * WARNING! This method will break the program flow. The program should be shut down after
 * running this.
 */
function KillAllAndClearQueue () {
  processLimiterDatabase = {}
  return Promise.all(ongoingProcesses.map(ongoingProcess => {
    return crossPlatformKillProcessIfValid(ongoingProcess)
  }))
}

/**
 * ProcessLimiter will only allow one simultaneous execution of the same processName. Function will
 * wait, with promises, until it's turn.
 *
 * To run the same actual command in parallel, use two different processNames (eg. "ffmpeg1", "ffmpeg2")
 *
 * @param {string} processName Name of current process. Only one process with the same name allowed at the same time
 * @param {string} command Command to be run. Eg. "ffmpeg.exe"
 * @param {ReadonlyArray<string>} commandArgs Command arguments
 * @param {(chunk: any) => void} stderrDataCallback Callback to be run on every stderr return.
 * @param {(chunk: any) => void} stdoutDataCallback Callback to be run on every stdout return
 */
async function ProcessLimiter (processName, command, commandArgs, stderrDataCallback, stdoutDataCallback) {
  let doneProcessing = await yourTurn(processName)
  let possibleErr = null
  return new Promise((resolve, reject) => {
    let processSpawn = ChildProcess.spawn(command, commandArgs, { shell: true })
    ongoingProcesses.push(processSpawn)
    processSpawn.stdout.on('data', stdoutDataCallback)
    processSpawn.stderr.on('data', stderrDataCallback)
    processSpawn.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Process with pid ${processSpawn ? processSpawn.pid : 'unknown'} exited with code ${code}`))
      }
      ongoingProcesses.splice(ongoingProcesses.indexOf(processSpawn), 1)
    })
  })
    .catch(error => {
      possibleErr = error
    })
    .then(() => {
      doneProcessing()
      if (possibleErr) {
        return Promise.reject(possibleErr)
      }
    })
}

module.exports = {
  ProcessLimiter,
  KillAllAndClearQueue
}
