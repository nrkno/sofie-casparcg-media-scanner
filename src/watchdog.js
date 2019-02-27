// @ts-check
/**
 * The purpose of this file is to make occasional checks if media-scanner behaves as it should.
 * If it doesn't, kill the process and let the parent process restart it.
 */
// const PouchDB = require('pouchdb-node')
const { killAllChildProcesses, currentlyScanningFileId, progressReport } = require('./scanner')
const fs = require('fs')
const config = require('./config')
const { KillAllAndClearQueue } = require('./processLimiter')
/** How often to run the watchdog */
const CHECK_INTERVAL = Number(process.env.MS_WATCHDOG_CHECK_INTERVAL) || 5 * 60 * 1000
/** Maximum time to expect the changes in the database */
const EXPECT_TIME = Number(process.env.MS_WATCHDOG_EXPECT_TIME) || 30 * 1000

const WATCHDOG_FILE = 'watchdog.mov'

async function cleanUpOldWatchdogFiles(logger, path) {
  try {
    const files = await promisify(fs.readdir, path)

    await Promise.all(files.map(fileName => {
      if (fileName.match(/_watchdogIgnore_/i)) {
        const filePath = `${path}/${fileName}`

        logger.info('Watchdog: Removing old file ' + fileName)
        return removeFile(filePath)
      } else {
        return Promise.resolve()
      }
    }))
  } catch (err) {
    logger.error(err)
    logger.error(err.stack)
  }
}

async function checkScannerFunctionality(logger, db, path, fileName) {
  const copyFileName = fileName.replace(/(.+)\.([^.]+)$/, `$1_watchdogIgnore_${Date.now()}.$2`)

  const inputPath = `${path}/${fileName}`
  const outputPath = `${path}/${copyFileName}`

  logger.info('Watchdog: check')

  let removeFileResolve = null
  let removeFileReject = null
  let removeFileResolved = false
  let timeoutPromise = new Promise((resolve, reject) => {
    removeFileResolve = resolve
    removeFileReject = reject
  })

  let createFileResolve = null
  let createFileReject = null
  let createFileResovled = false
  let createFilePromise = new Promise((resolve, reject) => {
    createFileResolve = resolve
    createFileReject = reject
  })

  let createdFileId = null

  let hasCreatedFile = (id) => {
    // Called when the file has appeared
    createdFileId = id
    if (!createFileResovled) {
      createFileResolve()
      createFileResovled = true
    }
  }

  let hasRemovedFile = () => {
    // Called when the file has appeared
    createdFileId = null
    if (!removeFileResolved) {
      removeFileResolve()
      removeFileResolved = true
    }
  }

  // Clean up old files created by old watchdog runs:
  await cleanUpOldWatchdogFiles(logger, path)

  // Watch the pouchdb for changes:
  let changesListener = db.changes({
    since: 'now',
    include_docs: true,
    live: true,
    attachments: false
  }).on('change', (change) => {
    if (change.deleted) {
      if (change.id === createdFileId) {
        hasRemovedFile()
      }
    } else if (change.doc) {
      let mediaPath = change.doc.mediaPath

      if (mediaPath.match(new RegExp(copyFileName, 'i'))) {
        hasCreatedFile(change.id)
      }
    }
  })
  // First, we make a copy of a file, and expect to see the file in the database later:

  logger.info('Watchdog: Copy file ' + copyFileName)
  // Copy the file
  await promisify(fs.copyFile, inputPath, outputPath)

  logger.info('Watchdog: wait for changes')
  // Wait for the change in pouchdb

  setTimeout(() => {
    if (!createFileResovled) {
      createFileReject(new Error('Timeout: Created file didnt appear in database'))
    }
  }, EXPECT_TIME)
  await createFilePromise

  // Then, we remove the copy and expect to see the file removed from the database
  logger.info('Watchdog: remove file')

  await removeFile(outputPath)
  logger.info('Watchdog: wait for changes')

  setTimeout(() => {
    if (!removeFileResolved) {
      removeFileReject(new Error('Timeout: Removed file wasnt removed from database'))
    }
  }, EXPECT_TIME)
  // Wait for the change in pouchdb
  await timeoutPromise
    .catch(err => {
      changesListener.cancel()
      return Promise.reject(err)
    })
    .then(data => {
      changesListener.cancel()
      return data
    })
  // Looks good at this point.
}

function removeFile(path) {
  // Remove file, and try again if not successful

  return new Promise((resolve, reject) => {
    let triesLeft = 5
    function unlink() {
      triesLeft--
      fs.unlink(path, (err) => {
        if (err) {
          if (
            triesLeft > 0 &&
            err.toString().match(/EBUSY/)
          ) {
            // try again later:
            setTimeout(() => {
              unlink()
            }, 1000)
          } else {
            reject(err)
          }
        } else {
          resolve()
        }
      })
    }
    unlink()
  })
}

function promisify(fcn) {
  let args = []
  for (let i in arguments) {
    args.push(arguments[i])
  }
  args.splice(0, 1)

  return new Promise((resolve, reject) => {
    args.push((err, result) => {
      if (err) reject(err)
      else resolve(result)
    })
    fcn.apply(this, args)
  })
}

let watchdogInterval
let previousScan = null
let previousProgressReport = null
module.exports.startWatchDog = function (logger, db) {
  const basePath = config.scanner.paths
  const path = `${basePath}/${WATCHDOG_FILE}`

  // We're using a file called "watchdog.mov" to do the watchdog routine
  fs.exists(path, (exists) => {
    if (exists) {
      // Start the watchdog:
      const triggerWatchDog = () => {
        let currentScan = currentlyScanningFileId()
        let currentProgressReport = progressReport()
        if (currentProgressReport && currentProgressReport !== previousProgressReport) {
          // if (currentScan && lastScan !== currentScan) {
          previousProgressReport = currentProgressReport
          previousScan = currentScan
          logger.info('Watchdog: skipping. File processing. ' + previousProgressReport.getTime())
          return
        } else {
          if (currentScan && previousScan === currentScan) {
            logger.info('Same scan blocking WatchDog two times in a row, forcing watchdog run')
          }
          if (currentProgressReport && previousProgressReport === currentProgressReport) {
            logger.info('Same scan blocking WatchDog two times in a row, forcing watchdog run')
          }
        }

        previousScan = currentScan
        checkScannerFunctionality(logger, db, basePath, WATCHDOG_FILE)
          .then(() => {
            logger.info('Watchdog: ok')
          })
          .catch(err => {
            if (err.toString().match(/Timeout:/)) {
              logger.info(`Watchdog failed, shutting down!`)
              setTimeout(() => {
                Promise.all([
                  killAllChildProcesses(),
                  KillAllAndClearQueue()])
                  .catch((error) => {
                    logger.error('Error killing child processes')
                    logger.error(error)
                  })
                  .then(() => {
                    process.exit(1)
                  })
              }, 1 * 1000)
            } else {
              logger.error('Error in watchdog:')
              logger.error(err)
              logger.error(err.stack)
            }
          })
      }
      watchdogInterval = setInterval(triggerWatchDog, CHECK_INTERVAL)
    } else {
      logger.warn(`Watchdog is disabled because ${path} wasn't found`)
    }
  })
}

module.exports.stopWatchDog = function () {
  if (watchdogInterval) {
    clearInterval(watchdogInterval)
    watchdogInterval = undefined
  }
}
