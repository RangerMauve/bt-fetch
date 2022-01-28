const makeFetch = require('make-fetch')
const path = require('path')
const Main = require('./main.js')
const streamToIterator = require('stream-async-iterator')
const mime = require('mime/lite')
const parseRange = require('range-parser')

const checkHash = new RegExp('^[a-fA-F0-9]{40}$')
const checkAddress = new RegExp('^[a-fA-F0-9]{64}$')
const DEFAULT_OPTS = {
  folder: __dirname,
  storage: 'storage',
  author: 'author'
}

module.exports = function makeBTFetch (opts = {}) {
  const finalOpts = { ...DEFAULT_OPTS, ...opts }

  const SUPPORTED_METHODS = ['GET', 'POST', 'DELETE', 'HEAD']
  // const sideType = '-'
  const hostType = '_'

  const app = new Main(finalOpts)

  const prog = new Map()

  async function getBody (body) {
    let mainData = ''

    for await (const data of body) {
      mainData += data
    }

    return mainData
  }

  function getMimeType (path) {
    let mimeType = mime.getType(path) || 'text/plain'
    if (mimeType.startsWith('text/')) mimeType = `${mimeType}; charset=utf-8`
    return mimeType
  }

  function formatReq (hostname, pathname, method, search, headers) {
    // let mainType = hostname[0] === hostType || hostname[0] === sideType ? hostname[0] : ''
    const mainType = hostname[0] === hostType
    const mainQuery = mainType ? hostname.replace(hostname[0], '') : hostname
    const mainHost = hostname
    // if(pathname){
    //     console.log(decodeURIComponent(pathname))
    // }
    const mainPath = pathname ? decodeURIComponent(pathname).replace(/\//g, path.sep) : path.sep
    const mainMethod = method
    const mainReq = headers.accept && headers.accept.includes('text/html')
    const mainRes = mainReq ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'
    let mainUpdate = search.get('update')
    mainUpdate = mainUpdate ? JSON.parse(mainUpdate) : null
    let mainRemove = search.get('remove')
    mainRemove = mainRemove ? JSON.parse(mainRemove) : null
    const mainRange = headers.Range || headers.range
    return { mainQuery, mainHost, mainPath, mainMethod, mainReq, mainRes, mainType, mainUpdate, mainRemove, mainRange }
  }

  const fetch = makeFetch(async request => {
    // if (request.body !== null) {
    //   request.body = await getBody(request.body)
    //   try {
    //     request.body = JSON.parse(request.body)
    //   } catch (error) {
    //     console.log(error)
    //   }
    // }

    const { url, method, headers: reqHeaders, body } = request

    try {
      const { hostname, pathname, protocol, searchParams } = new URL(url)

      if (protocol !== 'bittorrent:') {
        return {statusCode: 409, headers: {}, data: ['wrong protocol']}
      } else if(!method || !SUPPORTED_METHODS.includes(method)){
        return {statusCode: 409, headers: {}, data: ['something wrong with method']}
      } else if((!hostname) || (hostname.length !== 1 && hostname.length !== 32 && hostname.length !== 40 && hostname.length !== 64) || (hostname.length === 1 && hostname !== hostType) || (hostname.length !== 1 && !checkHash.test(hostname) && !checkAddress.test(hostname))){
        return {statusCode: 409, headers: {}, data: ['something wrong with hostname']}
      }

      const req = formatReq(hostname, pathname, method, searchParams, reqHeaders)

      const res = { statusCode: 400, headers: {}, data: [] }
      switch (req.mainMethod) {
        case 'HEAD': {
          if (req.mainType) {
            res.statusCode = 400
            res.headers['Content-Length'] = 0
          } else {
            if (prog.has(req.mainQuery)) {
              const torrentData = prog.get(req.mainQuery)
              if (req.mainPath === path.sep) {
                res.headers['Content-Type'] = req.mainRes
                res.headers['Content-Length'] = `${torrentData.length}`
                res.headers['Accept-Ranges'] = 'bytes'
                res.headers['X-Downloaded'] = `${torrentData.downloaded}`
                res.statusCode = 200
              } else {
                let tempPath = null
                if (torrentData.files.length === 1 && torrentData.name === torrentData.files[0].name) {
                  tempPath = torrentData.path + path.sep
                } else {
                  tempPath = torrentData.path + path.sep + torrentData.name + path.sep
                }
                const foundFile = torrentData.files.find(file => { file.path.replace(tempPath, '') === req.mainPath })
                if (foundFile) {
                  res.headers['Content-Type'] = getMimeType(req.mainPath)
                  res.headers['Content-Length'] = `${foundFile.length}`
                  res.headers['Accept-Ranges'] = 'bytes'
                  res.headers['X-Downloaded'] = `${foundFile.downloaded}`
                  res.statusCode = 200
                } else {
                  res.statusCode = 400
                  res.headers['Content-Length'] = 0
                }
              }
            } else {
              res.statusCode = 400
              res.headers['Content-Length'] = 0
            }
          }
          break
        }

        case 'GET': {
          if (req.mainType) {
            res.data = req.mainReq ? ['Thank you for using BT-Fetch'] : [JSON.stringify('Thank you for using BT-Fetch')]
            res.statusCode = 200
            res.headers['Content-Type'] = req.mainRes
          } else {
            let torrentData = null
            let foundFile = null
            let tempPath = null
            if (prog.has(req.mainQuery)) {
              torrentData = prog.get(req.mainQuery)
            } else {
              if (req.mainQuery.length === 64){
                try {
                  torrentData = await app.currentAddress(req.mainQuery)
                } catch (error) {
                  console.log(error)
                }
                if(!torrentData){
                  torrentData = await app.loadAddress(req.mainQuery)
                }
                prog.set(torrentData.address, torrentData)
              } else if (req.mainQuery.length === 40){
                try {
                  torrentData = await app.currentHash(req.mainQuery)
                } catch (error) {
                  console.log(error)
                }
                if(!torrentData){
                  torrentData = await app.loadHash(req.mainQuery)
                }
                prog.set(torrentData.hash, torrentData)
              }
            }
            tempPath = torrentData.files.length === 1 && torrentData.name === torrentData.files[0].name ? torrentData.path + path.sep : torrentData.path + path.sep + torrentData.name + path.sep
            if (req.mainPath === path.sep) {
              res.data = req.mainReq ? [`<html><head><title>${torrentData.infoHash}</title></head><body><div>${torrentData.files.map(file => { return `<p><a href="/${file.path.replace(tempPath, '').split(path.sep).map(data => { return encodeURIComponent(data) }).join('/')}">${file.name}</a></p>` })}</div></body></html>`] : [JSON.stringify(torrentData.files.map(file => { return `/${file.path.replace(tempPath, '').split(path.sep).map(data => { return encodeURIComponent(data) }).join('/')}` }))]
              res.statusCode = 200
              res.headers['Content-Type'] = req.mainRes
              res.headers['Content-Length'] = torrentData.length
            } else {
              foundFile = torrentData.files.find(file => { file.path.replace(tempPath, '') === req.mainPath })
              if (foundFile) {
                if (req.mainRange) {
                  const ranges = parseRange(foundFile.length, req.mainRange)
                  if (ranges && ranges.length && ranges.type === 'bytes') {
                    const [{ start, end }] = ranges
                    const length = (end - start + 1)

                    res.data = streamToIterator(foundFile.createReadStream({start, end}))
                    res.headers['Content-Length'] = `${length}`
                    res.headers['Content-Range'] = `bytes ${start}-${end}/${foundFile.length}`
                  }
                  res.statusCode = 206
                  res.headers['Content-Type'] = getMimeType(req.mainPath)
                } else {
                  res.data = streamToIterator(foundFile.createReadStream())
                  res.headers['Content-Type'] = getMimeType(req.mainPath)
                  res.headers['Content-Length'] = foundFile.length
                  res.statusCode = 200
                }
              } else {
                res.data = [JSON.stringify('file was not found')]
                res.statusCode = 404
                res.headers['Content-Type'] = 'application/json; charset=utf-8'
              }
            }
          }
          break
        }

        case 'POST': {
          if (req.mainType) {
            if (!body) {
              res.data = req.mainReq ? ['<html><head><title>BT-Fetch</title></head><body><div><p>body is required</p></div></body></html>'] : [JSON.stringify('body is required')]
              res.statusCode = 400
            } else if(!reqHeaders['content-type'] || !reqHeaders['content-type'].includes('multipart/form-data')){
              res.data = req.mainReq ? ['<html><head><title>BT-Fetch</title></head><body><div><p>Content-Type header is invalud</p></div></body></html>'] : [JSON.stringify('Content-Type header is invalid')]
              res.statusCode = 400
            } else if(req.mainUpdate === null){
              res.data = req.mainReq ? ['<html><head><title>BT-Fetch</title></head><body><div><p>url param "update" is required</p></div></body></html>'] : [JSON.stringify('url param "update" is required')]
              res.statusCode = 400
            } else if(req.mainUpdate === true){
                const { torrent, secret } = await app.publishAddress(null, reqHeaders, body)
                prog.set(torrent.address, torrent)
                res.data = req.mainReq ? [`<html><head><title>${torrent.address}</title></head><body><div><p>address: ${torrent.address}</p><p>infohash: ${torrent.infoHash}</p><p>sequence: ${torrent.sequence}</p><p>signature: ${torrent.sig}</p><p>magnet: ${torrent.magnet}</p><p>secret: ${secret}</p></div></body></html>`] : [JSON.stringify({ address: torrent.address, infohash: torrent.infoHash, sequence: torrent.sequence, magnet: torrent.magnet, signature: torrent.sig, secret })]
                res.statusCode = 200
            } else if(req.mainUpdate === false){
                const { torrent, hash } = await app.publishHash(null, reqHeaders, body)
                prog.set(torrent.hash, torrent)
                res.data = req.mainReq ? [`<html><head><title>${torrent.hash}</title></head><body><div><p>infohash: ${torrent.infoHash}</p><p>folder: ${hash}</p></div></body></html>`] : [JSON.stringify({ infohash: torrent.infoHash, hash })]
                res.statusCode = 200
            }
            res.headers['Content-Type'] = req.mainRes
          } else {
            if(!body){
              res.data = req.mainReq ? ['<html><head><title>BT-Fetch</title></head><body><div><p>body is required</p></div></body></html>'] : [JSON.stringify('body is required')]
              res.statusCode = 400
            } else if(!reqHeaders['content-type'] || !reqHeaders['content-type'].includes('multipart/form-data')){
              res.data = req.mainReq ? ['<html><head><title>BT-Fetch</title></head><body><div><p>Content-Type header is invalud</p></div></body></html>'] : [JSON.stringify('Content-Type header is invalid')]
              res.statusCode = 400
            } else {
              if(req.mainQuery.length === 64){
                if(!reqHeaders['authorization']){
                  res.data = req.mainReq ? ['<html><head><title>BT-Fetch</title></head><body><div><p>secret key is required in the Authorizatiion header</p></div></body></html>'] : [JSON.stringify('secret key is needed inside the Authorization header')]
                  res.statusCode = 400
                } else {
                  if(prog.has(req.mainQuery)){
                    prog.delete(req.mainQuery)
                  }
                  const { torrent, secret } = await app.publishAddress({address: req.mainQuery, secret: reqHeaders['authorization']}, reqHeaders, body)
                  prog.set(torrent.address, torrent)
                  res.data = req.mainReq ? [`<html><head><title>${torrent.address}</title></head><body><div><p>address: ${torrent.address}</p><p>infohash: ${torrent.infoHash}</p><p>sequence: ${torrent.sequence}</p><p>signature: ${torrent.sig}</p><p>magnet: ${torrent.magnet}</p><p>secret: ${secret}</p></div></body></html>`] : [JSON.stringify({ address: torrent.address, infohash: torrent.infoHash, sequence: torrent.sequence, magnet: torrent.magnet, signature: torrent.sig, secret })]
                  res.statusCode = 200
                }
              } else if(req.mainQuery.length === 40){
                if(prog.has(req.mainQuery)){
                  prog.delete(req.mainQuery)
                }
                const { torrent, hash } = await app.publishHash(req.mainQuery, reqHeaders, body)
                prog.set(torrent.hash, torrent)
                res.data = req.mainReq ? [`<html><head><title>${torrent.hash}</title></head><body><div><p>infohash: ${torrent.infoHash}</p><p>folder: ${hash}</p></div></body></html>`] : [JSON.stringify({ infohash: torrent.hash, hash })]
                res.statusCode = 200
              }
            }
            res.headers['Content-Type'] = req.mainRes
          }
          break
        }

        case 'DELETE': {
          if (req.mainType) {
            if(req.mainQuery){
              res.data = req.mainReq ? ['can not have underscore'] : [JSON.stringify('can not have underscore')]
              res.statusCode = 400
            } else {
              res.data = req.mainReq ? ['must have hash or address'] : [JSON.stringify('must have hash or address')]
              res.statusCode = 400
            }
            res.headers['Content-Type'] = req.mainRes
          } else {
            if(req.mainRemove === null){
              res.data = req.mainReq ? [`<html><head><title>BT-Fetch</title></head><body><div><p>url param "remove" is required</p></div></body></html>`] : [JSON.stringify('url param "remove" is required')]
              res.statusCode = 400
            } else {
              if(prog.has(req.mainQuery)) {
                prog.delete(req.mainQuery)
              }
              if (req.mainQuery.length === 64) {
                res.data = req.mainReq ? [`<html><head><title>${req.mainQuery}</title></head><body><div><p>${req.mainRemove ? await app.removeAddress(req.mainQuery) : app.stopAddress(req.mainQuery)}</p></div></body></html>`] : [JSON.stringify(req.mainRemove ? await app.removeAddress(req.mainQuery) : app.stopAddress(req.mainQuery))]
                res.statusCode = 200
              } else if (req.mainQuery.length === 40) {
                res.data = req.mainReq ? [`<html><head><title>${req.mainQuery}</title></head><body><div><p>${req.mainRemove ? await app.removeHash(req.mainQuery) : app.stopHash(req.mainQuery)}</p></div></body></html>`] : [JSON.stringify(req.mainRemove ? await app.removeHash(req.mainQuery) : app.stopHash(req.mainQuery))]
                res.statusCode = 200
              }
            }
            res.headers['Content-Type'] = req.mainRes
          }
          break
        }
      }
      return res
    } catch (e) {
      return { statusCode: 500, headers: {}, data: [e.stack] }
    }
  })

  fetch.destroy = () => {
    return new Promise((resolve, reject) => {
      clearInterval(app.updateRoutine)
      app.webtorrent.destroy(error => {
        if (error) {
          reject(error)
        } else {
          app.webproperty.clearData().then(res => { resolve(res) }).catch(error => { reject(error) })
        }
      })
    })
  }

  return fetch
}
