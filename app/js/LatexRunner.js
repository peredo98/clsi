/* eslint-disable
    camelcase,
    handle-callback-err,
    no-return-assign,
    no-unused-vars,
*/
// TODO: This file was created by bulk-decaffeinate.
// Fix any style issues and re-enable lint.
/*
 * decaffeinate suggestions:
 * DS102: Remove unnecessary code created because of implicit returns
 * DS103: Rewrite code to no longer use __guard__
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
let LatexRunner
const Path = require('path')
const Settings = require('settings-sharelatex')
const logger = require('logger-sharelatex')
const Metrics = require('./Metrics')
const CommandRunner = require('./CommandRunner')

const ProcessTable = {} // table of currently running jobs (pids or docker container names)

module.exports = LatexRunner = {
  runLatex(project_id, options, callback) {
    let command
    if (callback == null) {
      callback = function(error) {}
    }
    let {
      directory,
      mainFile,
      compiler,
      timeout,
      image,
      environment,
      flags
    } = options
    if (!compiler) {
      compiler = 'pdflatex'
    }
    if (!timeout) {
      timeout = 60000
    } // milliseconds

    logger.log(
      { directory, compiler, timeout, mainFile, environment, flags },
      'starting compile'
    )

    // We want to run latexmk on the tex file which we will automatically
    // generate from the Rtex/Rmd/md file.
    mainFile = mainFile.replace(/\.(Rtex|md|Rmd)$/, '.tex')

    if (compiler === 'pdflatex') {
      command = LatexRunner._pdflatexCommand(mainFile, flags)
    } else if (compiler === 'latex') {
      command = LatexRunner._latexCommand(mainFile, flags)
    } else if (compiler === 'xelatex') {
      command = LatexRunner._xelatexCommand(mainFile, flags)
    } else if (compiler === 'lualatex') {
      command = LatexRunner._lualatexCommand(mainFile, flags)
    } else {
      return callback(new Error(`unknown compiler: ${compiler}`))
    }

    if (Settings.clsi != null ? Settings.clsi.strace : undefined) {
      command = ['strace', '-o', 'strace', '-ff'].concat(command)
    }

    const id = `${project_id}` // record running project under this id

    return (ProcessTable[id] = CommandRunner.run(
      project_id,
      command,
      directory,
      image,
      timeout,
      environment,
      function(error, output) {
        delete ProcessTable[id]
        if (error != null) {
          return callback(error)
        }
        const runs =
          __guard__(
            __guard__(output != null ? output.stderr : undefined, x1 =>
              x1.match(/^Run number \d+ of .*latex/gm)
            ),
            x => x.length
          ) || 0
        const failed =
          __guard__(output != null ? output.stdout : undefined, x2 =>
            x2.match(/^Latexmk: Errors/m)
          ) != null
            ? 1
            : 0
        // counters from latexmk output
        const stats = {}
        stats['latexmk-errors'] = failed
        stats['latex-runs'] = runs
        stats['latex-runs-with-errors'] = failed ? runs : 0
        stats[`latex-runs-${runs}`] = 1
        stats[`latex-runs-with-errors-${runs}`] = failed ? 1 : 0
        // timing information from /usr/bin/time
        const timings = {}
        const stderr = output != null ? output.stderr : undefined
        timings['cpu-percent'] =
          __guard__(
            stderr != null
              ? stderr.match(/Percent of CPU this job got: (\d+)/m)
              : undefined,
            x3 => x3[1]
          ) || 0
        timings['cpu-time'] =
          __guard__(
            stderr != null
              ? stderr.match(/User time.*: (\d+.\d+)/m)
              : undefined,
            x4 => x4[1]
          ) || 0
        timings['sys-time'] =
          __guard__(
            stderr != null
              ? stderr.match(/System time.*: (\d+.\d+)/m)
              : undefined,
            x5 => x5[1]
          ) || 0
        return callback(error, output, stats, timings)
      }
    ))
  },

  killLatex(project_id, callback) {
    if (callback == null) {
      callback = function(error) {}
    }
    const id = `${project_id}`
    logger.log({ id }, 'killing running compile')
    if (ProcessTable[id] == null) {
      logger.warn({ id }, 'no such project to kill')
      return callback(null)
    } else {
      return CommandRunner.kill(ProcessTable[id], callback)
    }
  },

  _latexmkBaseCommand(flags) {
    let args = [
      'latexmk',
      '-cd',
      '-f',
      '-jobname=output',
      '-auxdir=$COMPILE_DIR',
      '-outdir=$COMPILE_DIR',
      '-synctex=1',
      '-interaction=batchmode'
    ]
    if (flags) {
      args = args.concat(flags)
    }
    return (
      __guard__(
        Settings != null ? Settings.clsi : undefined,
        x => x.latexmkCommandPrefix
      ) || []
    ).concat(args)
  },

  _pdflatexCommand(mainFile, flags) {
    return LatexRunner._latexmkBaseCommand(flags).concat([
      '-pdf',
      Path.join('$COMPILE_DIR', mainFile)
    ])
  },

  _latexCommand(mainFile, flags) {
    return LatexRunner._latexmkBaseCommand(flags).concat([
      '-pdfdvi',
      Path.join('$COMPILE_DIR', mainFile)
    ])
  },

  _xelatexCommand(mainFile, flags) {
    return LatexRunner._latexmkBaseCommand(flags).concat([
      '-xelatex',
      Path.join('$COMPILE_DIR', mainFile)
    ])
  },

  _lualatexCommand(mainFile, flags) {
    return LatexRunner._latexmkBaseCommand(flags).concat([
      '-lualatex',
      Path.join('$COMPILE_DIR', mainFile)
    ])
  }
}

function __guard__(value, transform) {
  return typeof value !== 'undefined' && value !== null
    ? transform(value)
    : undefined
}
