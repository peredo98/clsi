/*
 * decaffeinate suggestions:
 * DS102: Remove unnecessary code created because of implicit returns
 * DS103: Rewrite code to no longer use __guard__
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
let tenMinutes
const Metrics = require('metrics-sharelatex')
Metrics.initialize('clsi')

const CompileController = require('./app/js/CompileController')
const Settings = require('settings-sharelatex')
const logger = require('logger-sharelatex')
logger.initialize('clsi')
if ((Settings.sentry != null ? Settings.sentry.dsn : undefined) != null) {
  logger.initializeErrorReporting(Settings.sentry.dsn)
}

const smokeTest = require('smoke-test-sharelatex')
const ContentTypeMapper = require('./app/js/ContentTypeMapper')
const Errors = require('./app/js/Errors')

const Path = require('path')
const fs = require('fs')

Metrics.open_sockets.monitor(logger)
Metrics.memory.monitor(logger)

const ProjectPersistenceManager = require('./app/js/ProjectPersistenceManager')
const OutputCacheManager = require('./app/js/OutputCacheManager')

require('./app/js/db').sync()

const express = require('express')
const bodyParser = require('body-parser')
const app = express()

Metrics.injectMetricsRoute(app)
app.use(Metrics.http.monitor(logger))

// Compile requests can take longer than the default two
// minutes (including file download time), so bump up the
// timeout a bit.
const TIMEOUT = 10 * 60 * 1000
app.use(function(req, res, next) {
  req.setTimeout(TIMEOUT)
  res.setTimeout(TIMEOUT)
  res.removeHeader('X-Powered-By')
  return next()
})

app.param('project_id', function(req, res, next, project_id) {
  if (project_id != null ? project_id.match(/^[a-zA-Z0-9_-]+$/) : undefined) {
    return next()
  } else {
    return next(new Error('invalid project id'))
  }
})

app.param('user_id', function(req, res, next, user_id) {
  if (user_id != null ? user_id.match(/^[0-9a-f]{24}$/) : undefined) {
    return next()
  } else {
    return next(new Error('invalid user id'))
  }
})

app.param('build_id', function(req, res, next, build_id) {
  if (
    build_id != null
      ? build_id.match(OutputCacheManager.BUILD_REGEX)
      : undefined
  ) {
    return next()
  } else {
    return next(new Error(`invalid build id ${build_id}`))
  }
})

app.post(
  '/project/:project_id/compile',
  bodyParser.json({ limit: Settings.compileSizeLimit }),
  CompileController.compile
)
app.post('/project/:project_id/compile/stop', CompileController.stopCompile)
app.delete('/project/:project_id', CompileController.clearCache)

app.get('/project/:project_id/sync/code', CompileController.syncFromCode)
app.get('/project/:project_id/sync/pdf', CompileController.syncFromPdf)
app.get('/project/:project_id/wordcount', CompileController.wordcount)
app.get('/project/:project_id/status', CompileController.status)

// Per-user containers
app.post(
  '/project/:project_id/user/:user_id/compile',
  bodyParser.json({ limit: Settings.compileSizeLimit }),
  CompileController.compile
)
app.post(
  '/project/:project_id/user/:user_id/compile/stop',
  CompileController.stopCompile
)
app.delete('/project/:project_id/user/:user_id', CompileController.clearCache)

app.get(
  '/project/:project_id/user/:user_id/sync/code',
  CompileController.syncFromCode
)
app.get(
  '/project/:project_id/user/:user_id/sync/pdf',
  CompileController.syncFromPdf
)
app.get(
  '/project/:project_id/user/:user_id/wordcount',
  CompileController.wordcount
)

const ForbidSymlinks = require('./app/js/StaticServerForbidSymlinks')

// create a static server which does not allow access to any symlinks
// avoids possible mismatch of root directory between middleware check
// and serving the files
const staticServer = ForbidSymlinks(express.static, Settings.path.compilesDir, {
  setHeaders(res, path, stat) {
    if (Path.basename(path) === 'output.pdf') {
      // Calculate an etag in the same way as nginx
      // https://github.com/tj/send/issues/65
      const etag = (path, stat) =>
        `"${Math.ceil(+stat.mtime / 1000).toString(16)}` +
        '-' +
        Number(stat.size).toString(16) +
        '"'
      res.set('Etag', etag(path, stat))
    }
    return res.set('Content-Type', ContentTypeMapper.map(path))
  }
})

app.get('/project/:project_id/user/:user_id/build/:build_id/output/*', function(
  req,
  res,
  next
) {
  // for specific build get the path from the OutputCacheManager (e.g. .clsi/buildId)
  req.url =
    `/${req.params.project_id}-${req.params.user_id}/` +
    OutputCacheManager.path(req.params.build_id, `/${req.params[0]}`)
  return staticServer(req, res, next)
})

app.get('/project/:project_id/build/:build_id/output/*', function(
  req,
  res,
  next
) {
  // for specific build get the path from the OutputCacheManager (e.g. .clsi/buildId)
  req.url =
    `/${req.params.project_id}/` +
    OutputCacheManager.path(req.params.build_id, `/${req.params[0]}`)
  return staticServer(req, res, next)
})

app.get('/project/:project_id/user/:user_id/output/*', function(
  req,
  res,
  next
) {
  // for specific user get the path to the top level file
  req.url = `/${req.params.project_id}-${req.params.user_id}/${req.params[0]}`
  return staticServer(req, res, next)
})

app.get('/project/:project_id/output/*', function(req, res, next) {
  if (
    (req.query != null ? req.query.build : undefined) != null &&
    req.query.build.match(OutputCacheManager.BUILD_REGEX)
  ) {
    // for specific build get the path from the OutputCacheManager (e.g. .clsi/buildId)
    req.url =
      `/${req.params.project_id}/` +
      OutputCacheManager.path(req.query.build, `/${req.params[0]}`)
  } else {
    req.url = `/${req.params.project_id}/${req.params[0]}`
  }
  return staticServer(req, res, next)
})

app.get('/oops', function(req, res, next) {
  logger.error({ err: 'hello' }, 'test error')
  return res.send('error\n')
})

app.get('/status', (req, res, next) => res.send('CLSI is alive\n'))

const resCacher = {
  contentType(setContentType) {
    this.setContentType = setContentType
  },
  send(code, body) {
    this.code = code
    this.body = body
  },

  // default the server to be down
  code: 500,
  body: {},
  setContentType: 'application/json'
}

if (Settings.smokeTest) {
  let runSmokeTest
  ;(runSmokeTest = function() {
    logger.log('running smoke tests')
    smokeTest.run(require.resolve(__dirname + '/test/smoke/js/SmokeTests.js'))(
      {},
      resCacher
    )
    return setTimeout(runSmokeTest, 30 * 1000)
  })()
}

app.get('/health_check', function(req, res) {
  res.contentType(resCacher != null ? resCacher.setContentType : undefined)
  return res
    .status(resCacher != null ? resCacher.code : undefined)
    .send(resCacher != null ? resCacher.body : undefined)
})

app.get('/smoke_test_force', (req, res) =>
  smokeTest.run(require.resolve(__dirname + '/test/smoke/js/SmokeTests.js'))(
    req,
    res
  )
)

const profiler = require('v8-profiler-node8')
app.get('/profile', function(req, res) {
  const time = parseInt(req.query.time || '1000')
  profiler.startProfiling('test')
  return setTimeout(function() {
    const profile = profiler.stopProfiling('test')
    return res.json(profile)
  }, time)
})

app.get('/heapdump', (req, res) =>
  require('heapdump').writeSnapshot(
    `/tmp/${Date.now()}.clsi.heapsnapshot`,
    (err, filename) => res.send(filename)
  )
)

app.use(function(error, req, res, next) {
  if (error instanceof Errors.NotFoundError) {
    logger.warn({ err: error, url: req.url }, 'not found error')
    return res.sendStatus(404)
  } else {
    logger.error({ err: error, url: req.url }, 'server error')
    return res.sendStatus((error != null ? error.statusCode : undefined) || 500)
  }
})

const net = require('net')
const os = require('os')

let STATE = 'up'

const loadTcpServer = net.createServer(function(socket) {
  socket.on('error', function(err) {
    if (err.code === 'ECONNRESET') {
      // this always comes up, we don't know why
      return
    }
    logger.err({ err }, 'error with socket on load check')
    return socket.destroy()
  })

  if (STATE === 'up' && Settings.internal.load_balancer_agent.report_load) {
    let availableWorkingCpus
    const currentLoad = os.loadavg()[0]

    // staging clis's have 1 cpu core only
    if (os.cpus().length === 1) {
      availableWorkingCpus = 1
    } else {
      availableWorkingCpus = os.cpus().length - 1
    }

    const freeLoad = availableWorkingCpus - currentLoad
    let freeLoadPercentage = Math.round((freeLoad / availableWorkingCpus) * 100)
    if (freeLoadPercentage <= 0) {
      freeLoadPercentage = 1 // when its 0 the server is set to drain and will move projects to different servers
    }
    socket.write(`up, ${freeLoadPercentage}%\n`, 'ASCII')
    return socket.end()
  } else {
    socket.write(`${STATE}\n`, 'ASCII')
    return socket.end()
  }
})

const loadHttpServer = express()

loadHttpServer.post('/state/up', function(req, res, next) {
  STATE = 'up'
  logger.info('getting message to set server to down')
  return res.sendStatus(204)
})

loadHttpServer.post('/state/down', function(req, res, next) {
  STATE = 'down'
  logger.info('getting message to set server to down')
  return res.sendStatus(204)
})

loadHttpServer.post('/state/maint', function(req, res, next) {
  STATE = 'maint'
  logger.info('getting message to set server to maint')
  return res.sendStatus(204)
})

const port =
  __guard__(
    Settings.internal != null ? Settings.internal.clsi : undefined,
    x => x.port
  ) || 3013
const host =
  __guard__(
    Settings.internal != null ? Settings.internal.clsi : undefined,
    x1 => x1.host
  ) || 'localhost'

const load_tcp_port = Settings.internal.load_balancer_agent.load_port
const load_http_port = Settings.internal.load_balancer_agent.local_port

if (!module.parent) {
  // Called directly
  app.listen(port, host, error =>
    logger.info(`CLSI starting up, listening on ${host}:${port}`)
  )

  loadTcpServer.listen(load_tcp_port, host, function(error) {
    if (error != null) {
      throw error
    }
    return logger.info(`Load tcp agent listening on load port ${load_tcp_port}`)
  })

  loadHttpServer.listen(load_http_port, host, function(error) {
    if (error != null) {
      throw error
    }
    return logger.info(
      `Load http agent listening on load port ${load_http_port}`
    )
  })
}

module.exports = app

setInterval(
  () => ProjectPersistenceManager.clearExpiredProjects(),
  (tenMinutes = 10 * 60 * 1000)
)

function __guard__(value, transform) {
  return typeof value !== 'undefined' && value !== null
    ? transform(value)
    : undefined
}
