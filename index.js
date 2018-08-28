"use strict";
/**
 * stream based dependencies fetching task
 * version: 0.0.12
 * author: tommyZZM
 */
// const fs = require("fs");
const path = require("path");
const os = require("os");
const R = require("ramda");
const shelljs = require("shelljs");
const request = require("request");
const requestProgress = require("request-progress");
const progress = require("progress");
const tars = require("tar-stream");
const gunzip = require("gunzip-maybe");
// const unzip = require("unzip");
const yauzl = require("yauzl");
const log = require("fancy-log");
const rimraf = require("rimraf");
const source = require('vinyl-source-stream');
const vfs = require("vinyl-fs");
const through = require("through2");
const streamToPromise = require("stream-to-promise");
const touch = require("touch");
const mkdirp = require("mkdirp");
// ...
const fs = require("mz/fs")
//const env_const = require("../lib/env_const");
// ...
//const os_platform = os.platform();
const cwd = process.cwd();
const argv = require("yargs")
  .alias("d", "deps")
  .array("deps")
  .default("wget", false)
  .default("force", false)
  .argv;

const shouldForceDownload = argv["force"];

const shouldUseWget = argv["use-wget"];

const bundleTypeCheckers = [
  [u => /.+\.tar\.gz$/i.test(u), bundleExtractorTarGz],
  [u => /.+\.zip$/i.test(u), bundleExtractorZip]
]

const noopChecker = [void 0, (read, distPath, sourceUrl, options) => {
  const name = options.name;
  return read.pipe(source(path.basename(name || sourceUrl))).pipe(vfs.dest(path.dirname(distPath)))
}]

const depsToDownloadNames = argv.deps;

// console.log("argv", argv);

const availableTemplateFunctions = {
  //...env_const
}

const defaultResolveUrlTemplate = url => url
  .replace(/\{\{([\w_-]+)\}\}/g, function(matched, functionName) {
    if (typeof availableTemplateFunctions[functionName] === "function") {
      return availableTemplateFunctions[functionName]();
    }
    return matched;
  });

module.exports = function(deps, depFolder, depCacheFolder = void 0) {
  return _ => deps.reduce((lastTask, dep) => {
    if (!Array.isArray(dep)) return lastTask;
    
    const [name, sourceUrl, options = {}] = dep;

    const shouldDownload = (!depsToDownloadNames || depsToDownloadNames.length === 0) ? 
      true : 
      R.contains(name, depsToDownloadNames);

    // console.log(name, shouldDownload);

    if (!shouldDownload) return lastTask;

    if (typeof sourceUrl !== "string" && Array.isArray(sourceUrl)) {

      let [ sourceUrlTemplate, subDepNames ] = sourceUrl;

      sourceUrlTemplate = defaultResolveUrlTemplate(sourceUrlTemplate)

      let checker = R.find(([regexpTest]) => regexpTest(sourceUrlTemplate), bundleTypeCheckers);

      if (!checker) checker = noopChecker;

      return lastTask.then(_ => {
        return subDepNames.map(subDepName => {
          return [
            [name, subDepName], 
            sourceUrlTemplate
              .replace(/\{\{\.\.\.\}\}/gi, subDepName)
          ];
        })
          .reduce((lastTask, dep) => {
            return lastTask.then(_ => processFetchDep(dep, checker, depFolder, depCacheFolder))
          }, Promise.resolve())
      });
    }

    const sourceUrlResolved = defaultResolveUrlTemplate(sourceUrl);

    let checker = R.find(([regexpTest]) => regexpTest(sourceUrlResolved), bundleTypeCheckers);

    // if no need to extract using a noop stream
    if (!checker) checker = noopChecker;
    
    return lastTask.then(_ => processFetchDep(
      [name, sourceUrlResolved, options], checker, depFolder, depCacheFolder)
    );
  
  }, Promise.resolve());
}

function processFetchDep(dep, checker, depFolder, depCacheFolder) {
  let [name, sourceUrl, options = {}] = dep;
  // if (typeof sourceUrl !== "string") return tasks;
  let [_, x] = checker;

  let namePath = name;
  if (Array.isArray(name)) {
    namePath = name.join("/");
    name = name.join("@");
  } else {
    options.name = name;
  }

  const downloadFileName = name + "_" + path.basename(sourceUrl);
  const depFolderFullPath = path.join(cwd, depFolder, namePath);
  const depCacheFolderFullPath = depCacheFolder ? path.join(cwd, depCacheFolder) : null;
  const depCachePath = depCacheFolder ? path.join(cwd, depCacheFolder, downloadFileName): null;

  log(`--- ${name} ---`);

  return fs.exists(depFolderFullPath)
    .then(isExits => isExits ? rimraf.sync(depFolderFullPath) : Promise.resolve())
    .then(_ => depCachePath ? fs.exists(depCachePath) : false)
    .then(cacheExits => {
      if (cacheExits && !shouldForceDownload) {
        return [cacheExits, fs.createReadStream(depCachePath)]
      }

      return [
        cacheExits,
        shouldUseWget ? 
          downloadByWget(sourceUrl, depCachePath) :
          downloadByRequest(sourceUrl)
      ]
    })
    .then(([cacheExits, read]) => {
      log((cacheExits && !shouldForceDownload) ?
        `cache found ${downloadFileName} ...` :
        `fetching ${downloadFileName} from '${sourceUrl}' ...`
      );

      const extract = x(read, depFolderFullPath, sourceUrl, options);

      if (!cacheExits) {
        depCacheFolder && log("will save cache ...");
        return Promise.all([
          streamToPromise(extract),
          depCacheFolderFullPath ? streamToPromise(
            read.pipe(source(downloadFileName))
              .pipe(vfs.dest(depCacheFolderFullPath))
          ) : Promise.resolve()
        ])
      }

      return streamToPromise(extract);
    })
    .then(_ => {
      log("extract complete ...");
    })
}

/**
 * 用命令行wget工具下载
 * @param {*} url 
 * @param {*} cachePath 
 */
function downloadByWget(url, cachePath) {
  // When the output is not a TTY, the progress bar always falls back to “dot”, even if ‘--progress=bar’ was passed to Wget during invokation. 
  // This behaviour can be overridden and the “bar” output forced by using the “force” parameter as ‘--progress=bar:force’.
  // https://www.gnu.org/software/wget/manual/html_node/Download-Options.html
  const exec_wget = `wget -q --progress=bar:force --show-progress ${url} -O ${path.basename(cachePath)}`;
  console.log(exec_wget);
  shelljs.cd(path.dirname(cachePath));
  // shelljs.exec(`wget -V`);
  shelljs.exec(
    exec_wget,
    {silent: false},
  );

  return fs.createReadStream(cachePath);
}

/**
 * 用request(nodejs http模块)下载
 * @param {*} url 
 */
function downloadByRequest(url) {
  let total = new Buffer("");
  let bar = requestProgressBar(url);

  return requestProgress(request(url, {
      followAllRedirects: true,
      followOriginalHttpMethod: true,
      forever: true,
      headers: {
        "User-Agent": "Wget/1.12 (cygwin)",
        "Accept": "*/*",
        "Connection": "Keep-Alive"
      }
    }).on('response', function (response) {
      console.log("response,code:", response.statusCode);
      console.log("response,headers", response.headers);
    }))
    .on("progress", bar.progress)
    .on("end", bar.complete)
    .pipe(through((buf, _, next) => {
      total = Buffer.concat([total, buf]);
      next();
    }, function (flush) {
      this.push(total);
      flush();
    }))
}
  
/**
 * 解压.tar.gz
 */
function bundleExtractorTarGz(read, folderExtractTo) {
  let parsing = tars.extract()

  let beforeFinish = [];

  parsing.on("entry", (header, stream, next) => {
    let fileName = header.name;
    let mode = header.mode;
    let type = header.type;

    stream.on('end', function () {
      next() // ready for next entry
    });

    let fileNamePaths = fileName.split("/");
    fileNamePaths[0] = folderExtractTo;
    let fileNameWritePath = fileNamePaths.join("/");
    let fileDir = path.dirname(fileNameWritePath);

    if (type === 'directory') {
      mkdirp.sync(fileNameWritePath, { mode })
    } else if (type === 'symlink') {
      beforeFinish.push(
        _ => fs.symlinkSync(
          header.linkname,
          fileNameWritePath
        )
      );
    } else if (type === 'file') {
      if (header.size === 0) {
        touch.sync(fileNameWritePath);
      } else {
        stream
          .pipe(source(path.basename(fileNameWritePath)))
          .pipe(vfs.dest(path.dirname(fileNameWritePath), {
            mode
          }))
          .on("error", _ => void 0);
      }
    } else {
      log("unknow chunk type:", type, fileNameWritePath);
    }

    stream.resume(); // just auto drain the stream
  }).on("error", _ => void 0);

  //const combine = streamCombiner(gunzip(), parsing);

  parsing.on('finish', function () {
    // all entries read
    beforeFinish.forEach(fn => fn());
    log('finished extracting to ...', folderExtractTo)
    //combine.emit("finish");
  })

  return read.pipe(gunzip()).pipe(parsing);
}

/**
 * 解压.zip
 */
function bundleExtractorZip(read, folderExtractTo, sourceUrl, options) {
  let concated = new Buffer("");
  let parsing = through((buf, _, next) => {
    concated = Buffer.concat([concated, buf]);
    next(null)
  }, flush => {
    yauzl.fromBuffer(concated, { lazyEntries : true }, function (err, zipfile) {
      if (err) throw err;
      zipfile.readEntry();
      zipfile.on("entry", function (entry) {
        // console.log(entry);
        if (/\/$/.test(entry.fileName)) {
          // Directory file names end with '/'.
          // Note that entires for directories themselves are optional.
          // An entry's fileName implicitly requires its parent directories to exist.
          zipfile.readEntry();
        } else {
          // file entry
          let fileName = entry.fileName;
          let fileNameWritePath;
          if (options.isContentZip) {
            fileNameWritePath = path.join(folderExtractTo, fileName);
          } else {
            let fileNamePaths = fileName.split("/");
            fileNamePaths[0] = folderExtractTo;
            fileNameWritePath = fileNamePaths.join("/");
          }
          mkdirp.sync(path.dirname(fileNameWritePath));
          touch.sync(fileNameWritePath);
          let fileNamePaths = fileName.split("/");
          zipfile.openReadStream(entry, function (err, readStream) {
            if (err) throw err;
            readStream.pipe(source(path.basename(fileNameWritePath)))
              .pipe(vfs.dest(path.dirname(fileNameWritePath)))
              .on('error', error => log('\n' + error.message));
          });
          zipfile.readEntry();
        }
      });
      zipfile.on("end", _ => {

        if (typeof options.afterExtract === "function") {
          options.afterExtract(folderExtractTo);
        }

        parsing.push(concated);
        flush()
      })
    })
  })

  return read.pipe(parsing);
}

function requestProgressBar(target) {
  let isFirstProgress = false;
  let bar;
  let lastTransferred = 0;
  let lastElapsed = 0;
  return {
    progress: (args) => {
      let { percent, speed, size, time } = args;
      let { total, transferred } = size;
      let { elapsed, remaining } = time;
      let dTransferred = transferred - lastTransferred;
      lastTransferred = transferred;
      let dElapsed = elapsed - lastElapsed;
      lastElapsed = elapsed;

      if (!isFirstProgress) {
        isFirstProgress = true;
        log('total', total)
        log(`downloading ${target}`)
      }

      if (!total) {
        let rate = dElapsed ? (dTransferred / dElapsed) : 0;
        process.stdout.clearLine();
        return process.stdout.write(
          `... ${rate.toFixed(2)}/bps ${remaining ? remaining : ''}\r`
        );
      }
      if (!bar) {
        bar = new progress(
          `[:bar] :percent :rate/bps :etas`,
          { total: total, width: 20 }
        );
      }
      bar.tick(dTransferred);
    },
    complete: () => {
      if (!bar) return log("complete ...");
      bar.tick(bar.total - bar.curr);
      if (bar.complete) {
        log("complete ...")
      }
    }
  }
}
