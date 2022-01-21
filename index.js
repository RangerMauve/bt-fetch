const makeFetch = require('make-fetch')
const path = require('path')
const Main = require('./main.js')
const streamToIterator = require('stream-async-iterator')
const mime = require('mime/lite')
const parseRange = require('range-parser')

const checkHash = new RegExp('^[a-fA-F0-9]{40}$')
const checkAddress = new RegExp('^[a-fA-F0-9]{64}$')
const checkTitle = new RegExp('^[a-f0-9]{32}$')
const DEFAULT_OPTS = {
    folder: __dirname,
    storage: 'storage',
    author: 'author',
}

module.exports = function makeBTFetch(opts = {}){
    const finalOpts = {...DEFAULT_OPTS, ...opts}

    const SUPPORTED_METHODS = ['GET', 'POST', 'DELETE', 'HEAD']
    // const sideType = '-'
    const hostType = '_'

    const app = new Main(finalOpts)

    const prog = new Map()

    const fetch = makeFetch(async request => {

        if(request.body !== null){
            request.body = await getBody(request.body)
            try {
                request.body = JSON.parse(request.body)
            } catch (error) {
                console.log(error)
            }
        }

        const {url, method, headers: reqHeaders, body} = request

          try {
              let {hostname, pathname, protocol, searchParams} = new URL(url)

              if((protocol !== 'bt:' || !method || !SUPPORTED_METHODS.includes(method) || !hostname) || (hostname.length === 1 && hostname !== hostType) || (hostname.length !== 1 && hostname.length !== 32 && hostname.length !== 40 && hostname.length !== 64) || (hostname.length !== 1 && !checkTitle.test(hostname) && !checkHash.test(hostname) && !checkAddress.test(hostname))){
                  console.log('something wrong with the query')
                  throw new Error('invalid query, must be a valid query')
              }

              let req = formatReq(hostname, pathname, method, searchParams, reqHeaders)

              let res = {statusCode: 400, headers: {}, data: []}
              switch (req.mainMethod) {

                case 'HEAD': {
                    if(req.mainType){
                        res.statusCode = 400
                        res.headers['Content-Length'] = 0
                    } else {
                        if(prog.has(req.mainQuery)){
                            let tempData = prog.get(req.mainQuery)
                            if(req.mainPath === path.sep){
                                res.headers['Content-Type'] = req.mainRes
                                res.headers['Content-Length'] = `${tempData.length}`
                                res.headers['Accept-Ranges'] = 'bytes'
                                res.headers['X-Downloaded'] = `${tempData.downloaded}`
                                res.statusCode = 200
                            } else {
                                let foundFile = tempData.files.find(data => {return data.path.endsWith(req.mainPath)})
                                if(foundFile){
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
                    if(req.mainType){
                        if(req.mainReq){
                            res.data = ['<html><head><title>Config</title></head><body><div><p>timeout: ' + app._status.timeout + '</p><p>Torrents: ' + app.webtorrent.torrents.length + '</p><p>initial: ' + app._status.initial + '</p><p>current: ' + app._status.current + '</p><p>share: ' + app._status.share + '</p><div></body></html>']
                        } else {
                            res.data = [JSON.stringify({timeout: app._timeOut, share: app._status.share, current: app._status.current, initial: app._status.initial, torrents: app.webtorrent.torrents.length})]
                        }
                        res.statusCode = 200
                        res.headers['Content-Type'] = req.mainRes
                    } else {
                        let tempData = null
                        let foundFile = null
                        let tempPath = null
                        if(req.mainQuery.length === 64){
                            if(prog.has(req.mainQuery)){
                                tempData = prog.get(req.mainQuery)
                            } else {
                                tempData = await app.loadAddress(req.mainQuery)
                                prog.set(tempData.address, tempData)
                            }
                            if(tempData.files.length === 1 && tempData.name === tempData.files[0].name){
                                tempPath = tempData.path + path.sep
                            } else {
                                tempPath = tempData.path + path.sep + tempData.name + path.sep
                            }
                            if(req.mainPath === path.sep){
                                if(req.mainReq){
                                    res.data = [`<html><head><title>${tempData.address}</title></head><body><div>${tempData.files.map(file => {return `<p><a href="bt://${tempData.address}/${file.path.replace(tempPath, '').split(path.sep).map(data => {return encodeURIComponent(data)}).join('/')}">${file.name}</a></p>`})}</div></body></html>`]
                                } else {
                                    res.data = [JSON.stringify(tempData.files.map(file => {return 'bt://' + tempData.address + '/' + file.path.replace(tempPath, '').split(path.sep).map(data => {return encodeURIComponent(data)}).join('/')}))]
                                }
                                res.statusCode = 200
                                res.headers['Content-Type'] = req.mainRes
                                res.headers['Content-Length'] = tempData.length
                            } else {
                                foundFile = tempData.files.find(file => {return file.path.endsWith(req.mainPath)})
                                if(foundFile){
                                    if(req.mainRange){
                                        let ranges = parseRange(foundFile.length, req.mainRange)
                                        if(ranges && ranges.length && ranges.type === 'bytes'){
                                            let [{ start, end }] = ranges
                                            let length = (end - start + 1)
                                            req.mainPartial.start = start
                                            req.mainPartial.end = end

                                            res.headers['Content-Length'] = `${length}`
                                            res.headers['Content-Range'] = `bytes ${start}-${end}/${foundFile.length}`
                                        }
                                        res.statusCode = 206
                                        res.data = streamToIterator(foundFile.createReadStream(req.mainPartial))
                                        res.headers['Content-Type'] = getMimeType(req.mainPath)
                                    } else {
                                        res.data = streamToIterator(foundFile.createReadStream())
                                        res.headers['Content-Type'] = getMimeType(req.mainPath)
                                        res.headers['Content-Length'] = foundFile.length
                                        res.statusCode = 200
                                    }
                                } else {
                                    res.data = [JSON.stringify('file was not found')]
                                    res.statusCode = 400
                                    res.headers['Content-Type'] = 'application/json; charset=utf-8'
                                }
                            }
                        } else if(req.mainQuery.length === 40){
                            if(prog.has(req.mainQuery)){
                                tempData = prog.get(req.mainQuery)
                            } else {
                                tempData = await app.loadHash(req.mainQuery)
                                prog.set(tempData.infoHash, tempData)
                            }
                            if(tempData.files.length === 1 && tempData.name === tempData.files[0].name){
                                tempPath = tempData.path + path.sep
                            } else {
                                tempPath = tempData.path + path.sep + tempData.name + path.sep
                            }
                            if(req.mainPath === path.sep){
                                if(req.mainReq){
                                    res.data = [`<html><head><title>${tempData.infoHash}</title></head><body><div>${tempData.files.map(file => {return `<p><a href="bt://${tempData.infoHash}/${file.path.replace(tempPath, '').split(path.sep).map(data => {return encodeURIComponent(data)}).join('/')}">${file.name}</a></p>`})}</div></body></html>`]
                                } else {
                                    res.data = [JSON.stringify(tempData.files.map(file => {return 'bt://' + tempData.infoHash + '/' + file.path.replace(tempPath, '').split(path.sep).map(data => {return encodeURIComponent(data)}).join('/')}))]
                                }
                                res.statusCode = 200
                                res.headers['Content-Type'] = req.mainRes
                                res.headers['Content-Length'] = tempData.length
                            } else {
                                foundFile = tempData.files.find(file => {return file.path.endsWith(req.mainPath)})
                                if(foundFile){
                                    if(req.mainRange){
                                        let ranges = parseRange(foundFile.length, req.mainRange)
                                        if(ranges && ranges.length && ranges.type === 'bytes'){
                                            let [{ start, end }] = ranges
                                            let length = (end - start + 1)
                                            req.mainPartial.start = start
                                            req.mainPartial.end = end

                                            res.headers['Content-Length'] = `${length}`
                                            res.headers['Content-Range'] = `bytes ${start}-${end}/${foundFile.length}`
                                        }
                                        res.statusCode = 206
                                        res.data = streamToIterator(foundFile.createReadStream(req.mainPartial))
                                        res.headers['Content-Type'] = getMimeType(req.mainPath)
                                    } else {
                                        res.data = streamToIterator(foundFile.createReadStream())
                                        res.headers['Content-Type'] = getMimeType(req.mainPath)
                                        res.headers['Content-Length'] = foundFile.length
                                        res.statusCode = 200
                                    }
                                } else {
                                    res.data = [JSON.stringify('file was not found')]
                                    res.statusCode = 400
                                    res.headers['Content-Type'] = 'application/json; charset=utf-8'
                                }
                            }
                        }
                    }
                  break
                }
                
                case 'POST': {
                    if(req.mainType){
                        if(!body){
                            if(req.mainReq){
                                res.data = [`<html><head><title>BT-Fetch</title></head><body><div><p>body is required</p></div></body></html>`]
                            } else {
                                res.data = [JSON.stringify('body is required')]
                            }
                            res.statusCode = 400
                        } else {
                            if(body.folder){
                                if(body.address === undefined || body.secret === undefined){
                                    let {torrent, title} = await app.publishTitle(body.folder)
                                    if(prog.has(torrent.infoHash)){
                                        prog.delete(torrent.infoHash)
                                        prog.set(torrent.infoHash, torrent)
                                    } else {
                                        prog.set(torrent.infoHash, torrent)
                                    }
                                    if(req.mainReq){
                                        res.data = [`<html><head><title>BT-Fetch</title></head><body><div><p>infohash: ${torrent.infoHash}</p><p>folder: ${title}</p></div></body></html>`]
                                    } else {
                                        res.data = [JSON.stringify({infohash: torrent.infoHash, title})]
                                    }
                                    res.statusCode = 200
                                } else {
                                    let {torrent, secret} = await app.publishAddress(body.folder, {address: body.address, secret: body.secret})
                                    if(prog.has(torrent.address)){
                                        prog.delete(torrent.address)
                                        prog.set(torrent.address, torrent)
                                    } else {
                                        prog.set(torrent.address, torrent)
                                    }
                                    if(req.mainReq){
                                        res.data = [`<html><head><title>BT-Fetch</title></head><body><div><p>address: ${torrent.address}</p><p>infohash: ${torrent.infoHash}</p><p>sequence: ${torrent.sequence}</p><p>signature: ${torrent.sig}</p><p>magnet: ${torrent.magnet}</p><p>secret: ${secret}</p></div></body></html>`]
                                    } else {
                                        res.data = [JSON.stringify({address: torrent.address, infohash: torrent.infoHash, sequence: torrent.sequence, magnet: torrent.magnet, signature: torrent.sig, secret})]
                                    }
                                    res.statusCode = 200
                                }
                            } else {
                                if(req.mainReq){
                                    res.data = [`<html><head><title>BT-Fetch</title></head><body><div><p>body is missing data</p></div></body></html>`]
                                } else {
                                    res.data = [JSON.stringify('body is missing data')]
                                }
                                res.statusCode = 400
                            }
                        }
                        res.headers['Content-Type'] = req.mainRes
                    } else {
                        if(req.mainQuery.length === 64){
                            let torrent = await app.currentAddress(req.mainQuery)
                            if(prog.has(torrent.address)){
                                prog.delete(torrent.address)
                                prog.set(torrent.address, torrent)
                            } else {
                                prog.set(torrent.address, torrent)
                            }
                            if(req.mainReq){
                                res.data = [`<html><head><title>BT-Fetch</title></head><body><div><p>address: ${torrent.address}</p><p>infohash: ${torrent.infoHash}</p></div></body></html>`]
                            } else {
                                res.data = [JSON.stringify({address: torrent.address, infoHash: torrent.infoHash})]
                            }
                            res.statusCode = 200
                        } else if(req.mainQuery.length === 32){
                            let torrent = await app.currentTitle(req.mainQuery)
                            if(prog.has(torrent.infoHash)){
                                prog.delete(torrent.infoHash)
                                prog.set(torrent.infoHash, torrent)
                            } else {
                                prog.set(torrent.infoHash, torrent)
                            }
                            if(req.mainReq){
                                res.data = [`<html><head><title>BT-Fetch</title></head><body><div><p>title: ${torrent.title}</p><p>infohash: ${torrent.infoHash}</p></div></body></html>`]
                            } else {
                                res.data = [JSON.stringify({title: torrent.title, infoHash: torrent.infoHash})]
                            }
                            res.statusCode = 200
                        }
                        res.headers['Content-Type'] = req.mainRes
                    }
                    break
                }

                case 'DELETE': {
                    if(req.mainType){
                        if(!body){
                            prog.clear()
                            if(req.mainReq){
                                res.data = [`<html><head><title>BT-Fetch</title></head><body><div><p>${app.clearData()}</p></div></body></html>`]
                            } else {
                                res.data = [JSON.stringify(app.clearData())]
                            }
                            res.statusCode = 400
                            // mainData = [await app.clearData()]
                            // prog.clear()
                        } else if(body.hash){
                            if(prog.has(body.hash)){
                                prog.delete(body.hash)
                            }
                            if(req.mainReq){
                                res.data = [`<html><head><title>BT-Fetch</title></head><body><div><p>${await app.removeHash(body.hash)}</p></div></body></html>`]
                            } else {
                                res.data = [JSON.stringify(await app.removeHash(body.hash))]
                            }
                            res.statusCode = 200
                        } else if(body.address){
                            if(prog.has(body.address)){
                                prog.delete(body.address)
                            }
                            if(req.mainReq){
                                res.data = [`<html><head><title>BT-Fetch</title></head><body><div><p>${await app.removeAddress(body.address)}</p></div></body></html>`]
                            } else {
                                res.data = [JSON.stringify(await app.removeAddress(body.address))]
                            }
                            res.statusCode = 200
                        } else if(body.title){
                            if(prog.has(body.title)){
                                prog.delete(body.title)
                            }
                            if(req.mainReq){
                                res.data = [`<html><head><title>BT-Fetch</title></head><body><div><p>${await app.removeTitle(body.title)}</p></div></body></html>`]
                            } else {
                                res.data = [JSON.stringify(await app.removeTitle(body.title))]
                            }
                            res.statusCode = 200
                        } else {
                            res.data = [JSON.stringify('body is missing data')]
                            res.statusCode = 400
                        }
                        res.headers['Content-Type'] = req.mainRes
                    } else {
                        if(req.mainQuery.length === 64){
                            if(prog.has(req.mainQuery)){
                                prog.delete(req.mainQuery)
                            }
                            if(req.mainReq){
                                res.data = [`<html><head><title>BT-Fetch</title></head><body><div><p>${app.stopAddress(req.mainQuery)}</p></div></body></html>`]
                            } else {
                                res.data = [JSON.stringify(app.stopAddress(req.mainQuery))]
                            }
                            res.statusCode = 200
                        } else if(req.mainQuery.length === 40){
                            if(prog.has(req.mainQuery)){
                                prog.delete(req.mainQuery)
                            }
                            if(req.mainReq){
                                mainData = [`<html><head><title>BT-Fetch</title></head><body><div><p>${app.stopHash(req.mainQuery)}</p></div></body></html>`]
                            } else {
                                mainData = [JSON.stringify(app.stopHash(req.mainQuery))]
                            }
                            res.statusCode = 200
                        } else if(req.mainQuery.length === 32){
                            if(prog.has(req.mainQuery)){
                                prog.delete(req.mainQuery)
                            }
                            if(req.mainReq){
                                mainData = [`<html><head><title>BT-Fetch</title></head><body><div><p>${app.stopTitle(req.mainQuery)}</p></div></body></html>`]
                            } else {
                                mainData = [JSON.stringify(app.stopTitle(req.mainQuery))]
                            }
                            res.statusCode = 200
                        }
                        res.headers['Content-Type'] = req.mainRes
                    }
                    break
                }
              }
              return res

          } catch (e) {
              return {statusCode: 500, headers: {}, data: [e.stack]}
          }
    })

    async function getBody(body) {
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

    function formatReq(hostname, pathname, method, search, headers){
        // let mainType = hostname[0] === hostType || hostname[0] === sideType ? hostname[0] : ''
        let mainType = hostname[0] === hostType
        let mainQuery = mainType ? hostname.replace(hostname[0], '') : hostname
        let mainHost = hostname
        // if(pathname){
        //     console.log(decodeURIComponent(pathname))
        // }
        let mainPath = pathname ? decodeURIComponent(pathname).replace(/\//g, path.sep) : path.sep
        let mainMethod = method
        let mainReq = headers.accept && headers.accept.includes('text/html')
        let mainRes = mainReq ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'
        let mainReg = search.get('clear') ? true : false
        let mainRange = headers.Range || headers.range
        let mainPartial = {}
        return {mainQuery, mainHost, mainPath, mainMethod, mainReg, mainReq, mainRes, mainType, mainRange, mainPartial}
    }

    fetch.destroy = () => {
        return new Promise((resolve, reject) => {
            app.webtorrent.destroy(error => {
                if(error){
                    reject(error)
                } else {
                    app.webproperty.clearData().then(res => {resolve(res)}).catch(error => {reject(error)})
                }
            })
        })
    }

    return fetch

}
