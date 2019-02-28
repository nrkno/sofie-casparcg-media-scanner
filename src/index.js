// @ts-check
const pino = require('pino')
const config = require('./config')
const PouchDB = require('pouchdb-node')
const { scanner } = require('./scanner')
const { previews } = require('./previews')
const app = require('./app')
const WatchDog = require('./watchdog')

const logger = pino(Object.assign({}, config.logger, {
  serializers: {
    err: pino.stdSerializers.err
  }
}))

const db = new PouchDB('_media') // `http://localhost:${config.http.port}/db/_media`)
logger.info('STARTING')
logger.info(config)

let scannerListener = scanner({ logger, db, config })
// scannerListener.cancel() to stop

app({ logger, db, config }).listen(config.http.port)

if (config.previews.enable) {
  let previewListener = previews({ logger, db, config })
  // previewListener.cancel() to stop
}
logger.info('STARTING watchdog')
WatchDog.startWatchDog(logger, db)
