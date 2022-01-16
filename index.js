const makeFetch = require('make-fetch')
const path = require('path')
const BTP = require('btp-torrent')
const streamToIterator = require('stream-async-iterator')
const mime = require('mime/lite')

const checkHash = new RegExp('^[a-fA-F0-9]{40}$')
const checkAddress = new RegExp('^[a-fA-F0-9]{64}$')
const checkTitle = new RegExp('^[a-f0-9]{32}$')
const DEFAULT_OPTS = {
    folder: __dirname,
    storage: 'storage',
    magnet: 'magnet',
}

module.exports = function makeBTFetch(opts = {}){
    const finalOpts = {...DEFAULT_OPTS, ...opts}

    const SUPPORTED_METHODS = ['GET', 'POST', 'DELETE', 'HEAD']
    // const sideType = '-'
    const hostType = '_'

    const app = new BTP({folder: finalOpts.folder, storage: finalOpts.storage, magnet: finalOpts.magnet})

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
                    let mainData = []
                    let checkCode = null
                    if(req.mainType){
                        if(req.mainQuery){
                            if(prog.has(req.mainQuery)){
                                checkCode = 200
                            } else {
                                checkCode = 400
                            }
                        } else {
                            checkCode = 400
                        }
                        res.data = mainData
                        res.statusCode = checkCode
                        res.headers = {}
                    } else {
                        let mainLength = null
                        if(prog.has(req.mainQuery)){
                            checkCode = 200
                            mainLength = prog.get(req.mainQuery).length
                        } else {
                            checkCode = 400
                            mainLength = 0
                        }
                        res.data = mainData
                        res.headers = {'Content-Length': mainLength}
                        res.statusCode = checkCode
                    }
                    break
                }
                  
                case 'GET': {
                    let mainData = null
                    if(req.mainType){
                        if(req.mainQuery){
                            if(req.mainReq){
                                mainData = ['<html><head><title>Config</title></head><body><div><p>hostname must be empty</p><div></body></html>']
                            } else {
                                mainData = [JSON.stringify('hostname must be empty')]
                            }
                            res.data = mainData
                            res.statusCode = 400
                            res.headers['Content-Type'] = req.mainRes
                        } else {
                            if(req.mainReq){
                                mainData = ['<html><head><title>Config</title></head><body><div><p>timeout: ' + app._status.timeout + '</p><p>Torrents: ' + app.webtorrent.torrents.length + '</p><p>initial: ' + app._status.initial + '</p><p>current: ' + app._status.current + '</p><p>share: ' + app._status.share + '</p><div></body></html>']
                            } else {
                                mainData = [JSON.stringify({timeout: app._timeOut, share: app._status.share, current: app._status.current, initial: app._status.initial, torrents: app.webtorrent.torrents.length})]
                            }
                            res.data = mainData
                            res.statusCode = 200
                            res.headers['Content-Type'] = req.mainRes
                        }
                    } else {
                        let tempData = null
                        if(req.mainQuery.length === 64){
                            if(prog.has(req.mainQuery)){
                                tempData = prog.get(req.mainQuery)
                            } else {
                                tempData = await app.loadAddress(req.mainQuery)
                                prog.set(req.mainQuery, tempData)
                            }
                            if(req.mainPath === path.sep){
                                if(req.mainReq){
                                    if(tempData.files.length === 1 && tempData.name === tempData.files[0].name){
                                        mainData = [`<html><head><title>BT-Fetch</title></head><body><div>${tempData.files.map(file => {return `<p><a href="bt://${tempData.address}/${file.path.replace(tempData.path + path.sep, '').split(path.sep).map(data => {return encodeURIComponent(data)}).join('/')}">${file.name}</a></p>`})}</div></body></html>`]
                                    } else {
                                        mainData = [`<html><head><title>BT-Fetch</title></head><body><div>${tempData.files.map(file => {return `<p><a href="bt://${tempData.address}/${file.path.replace(tempData.path + path.sep + tempData.name + path.sep, '').split(path.sep).map(data => {return encodeURIComponent(data)}).join('/')}">${file.name}</a></p>`})}</div></body></html>`]
                                    }
                                } else {
                                    if(tempData.files.length === 1 && tempData.name === tempData.files[0].name){
                                        mainData = [JSON.stringify(tempData.files.map(file => {return 'bt://' + tempData.address + '/' + file.path.replace(tempData.path + path.sep, '').split(path.sep).map(data => {return encodeURIComponent(data)}).join('/')}))]
                                    } else {
                                        mainData = [JSON.stringify(tempData.files.map(file => {return 'bt://' + tempData.address + '/' + file.path.replace(tempData.path + path.sep + tempData.name + path.sep, '').split(path.sep).map(data => {return encodeURIComponent(data)}).join('/')}))]
                                    }
                                }
                            } else {
                                // if(tempData.files.length === 1 && tempData.name === tempData.files[0].name){
                                //     mainData = streamToIterator(tempData.files.find(file => {return file.path.replace(tempData.path, '') === req.mainPath}).createReadStream())
                                // } else {
                                //     mainData = streamToIterator(tempData.files.find(file => {return file.path.replace(tempData.path + path.sep + tempData.name, '') === req.mainPath}).createReadStream())
                                // }
                                mainData = streamToIterator(tempData.files.find(file => {return file.endsWith(req.mainPath)}).createReadStream())
                            }
                        } else if(req.mainQuery.length === 40){
                            if(prog.has(req.mainQuery)){
                                tempData = prog.get(req.mainQuery)
                            } else {
                                tempData = await app.loadHash(req.mainQuery)
                                prog.set(req.mainQuery, tempData)
                            }
                            if(req.mainPath === path.sep){
                                if(req.mainReq){
                                    if(tempData.files.length === 1 && tempData.name === tempData.files[0].name){
                                        mainData = [`<html><head><title>BT-Fetch</title></head><body><div>${tempData.files.map(file => {return `<p><a href="bt://${tempData.infoHash}/${file.path.replace(tempData.path + path.sep, '').split(path.sep).map(data => {return encodeURIComponent(data)}).join('/')}">${file.name}</a></p>`})}</div></body></html>`]
                                    } else {
                                        mainData = [`<html><head><title>BT-Fetch</title></head><body><div>${tempData.files.map(file => {return `<p><a href="bt://${tempData.infoHash}/${file.path.replace(tempData.path + path.sep + tempData.name + path.sep, '').split(path.sep).map(data => {return encodeURIComponent(data)}).join('/')}">${file.name}</a></p>`})}</div></body></html>`]
                                    }
                                } else {
                                    if(tempData.files.length === 1 && tempData.name === tempData.files[0].name){
                                        mainData = [JSON.stringify(tempData.files.map(file => {return 'bt://' + tempData.infoHash + '/' + file.path.replace(tempData.path + path.sep, '').split(path.sep).map(data => {return encodeURIComponent(data)}).join('/')}))]
                                    } else {
                                        mainData = [JSON.stringify(tempData.files.map(file => {return 'bt://' + tempData.infoHash + '/' + file.path.replace(tempData.path + path.sep + tempData.name + path.sep, '').split(path.sep).map(data => {return encodeURIComponent(data)}).join('/')}))]
                                    }
                                }
                            } else {
                                // if(tempData.files.length === 1 && tempData.name === tempData.files[0].name){
                                //     mainData = streamToIterator(tempData.files.find(file => {return file.path.replace(tempData.path, '') === req.mainPath}).createReadStream())
                                // } else {
                                //     mainData = streamToIterator(tempData.files.find(file => {return file.path.replace(tempData.path + path.sep + tempData.name, '') === req.mainPath}).createReadStream())
                                // }
                                mainData = streamToIterator(tempData.files.find(file => {return file.path.endsWith(req.mainPath)}).createReadStream())
                            }
                        }
                        res.data = mainData
                        res.statusCode = 200
                        res.headers['Content-Type'] = req.mainPath === path.sep ? req.mainRes : getMimeType(req.mainPath)
                    }
                  break
                }
                
                case 'POST': {
                    let mainData = null
                    if(req.mainType){
                        if(!body){
                            if(req.mainReq){
                                mainData = [`<html><head><title>BT-Fetch</title></head><body><div><p>body is required</p></div></body></html>`]
                            } else {
                                mainData = [JSON.stringify('body is required')]
                            }
                        } else {
                            if(body.address === undefined || body.secret === undefined){
                                let {torrent, title} = await app.publishTitle(body.folder)
                                if(prog.has(torrent.infoHash)){
                                    prog.delete(torrent.infoHash)
                                    prog.set(torrent.infoHash, torrent)
                                } else {
                                    prog.set(torrent.infoHash, torrent)
                                }
                                if(req.mainReq){
                                    mainData = [`<html><head><title>BT-Fetch</title></head><body><div><p>infohash: ${torrent.infoHash}</p><p>folder: ${title}</p></div></body></html>`]
                                } else {
                                    mainData = [JSON.stringify({infohash: torrent.infoHash, title})]
                                }
                            } else {
                                let {torrent, secret} = await app.publishAddress(body.folder, {address: body.address, secret: body.secret})
                                if(prog.has(torrent.address)){
                                    prog.delete(torrent.address)
                                    prog.set(torrent.address, torrent)
                                } else {
                                    prog.set(torrent.address, torrent)
                                }
                                if(req.mainReq){
                                    mainData = [`<html><head><title>BT-Fetch</title></head><body><div><p>address: ${torrent.address}</p><p>infohash: ${torrent.infoHash}</p><p>sequence: ${torrent.sequence}</p><p>signature: ${torrent.sig}</p><p>magnet: ${torrent.magnet}</p><p>secret: ${secret}</p></div></body></html>`]
                                } else {
                                    mainData = [JSON.stringify({address: torrent.address, infohash: torrent.infoHash, sequence: torrent.sequence, magnet: torrent.magnet, signature: torrent.sig, secret})]
                                }
                            }
                        }
                        res.data = mainData
                        res.statusCode = 200
                        res.headers['Content-Type'] = req.mainRes
                    } else {
                        if(req.mainQuery.length === 64){
                            let torrent = await app.ownAddress(req.mainQuery)
                            if(prog.has(torrent.address)){
                                prog.delete(torrent.address)
                                prog.set(torrent.address, torrent)
                            } else {
                                prog.set(torrent.address, torrent)
                            }
                            if(req.mainReq){
                                mainData = [`<html><head><title>BT-Fetch</title></head><body><div><p>address: ${torrent.address}</p><p>infohash: ${torrent.infoHash}</p></div></body></html>`]
                            } else {
                                mainData = [JSON.stringify({address: torrent.address, infoHash: torrent.infoHash})]
                            }
                        } else if(req.mainQuery.length === 32){
                            let torrent = await app.ownTitle(req.mainQuery)
                            if(prog.has(torrent.infoHash)){
                                prog.delete(torrent.infoHash)
                                prog.set(torrent.infoHash, torrent)
                            } else {
                                prog.set(torrent.infoHash, torrent)
                            }
                            if(req.mainReq){
                                mainData = [`<html><head><title>BT-Fetch</title></head><body><div><p>title: ${torrent.title}</p><p>infohash: ${torrent.infoHash}</p></div></body></html>`]
                            } else {
                                mainData = [JSON.stringify({title: torrent.title, infoHash: torrent.infoHash})]
                            }
                        }
                        res.data = mainData
                        res.statusCode = 200
                        res.headers['Content-Type'] = req.mainRes
                    }
                    break
                }

                case 'DELETE': {
                    let mainData = null
                    let checkCode = null
                    if(req.mainType){
                        if(!body){
                            if(req.mainReq){
                                mainData = ['<html><head><title>BT-Fetch</title></head><body><div><p>body is required</p></div></body></html>']
                            } else {
                                mainData = [JSON.stringify('body is required')]
                            }
                            checkCode = 400
                            // mainData = [await app.clearData()]
                            // prog.clear()
                        } else {
                            if(body.remove !== undefined){
                                if(req.mainReq){
                                    mainData = [`<html><head><title>BT-Fetch</title></head><body><div><p>${await app.clearData(body.remove)}</p></div></body></html>`]
                                } else {
                                    mainData = [JSON.stringify(await app.clearData(body.remove))]
                                }
                                prog.clear()
                            } else if(body.hash){
                                if(req.mainReq){
                                    mainData = [`<html><head><title>BT-Fetch</title></head><body><div><p>${await app.removeHash(body.hash)}</p></div></body></html>`]
                                } else {
                                    mainData = [JSON.stringify(await app.removeHash(body.hash))]
                                }
                                // mainData = [await app.removeHash(body.hash)]
                                if(prog.has(body.hash)){
                                    prog.delete(body.hash)
                                }
                            } else if(body.address){
                                if(req.mainReq){
                                    mainData = [`<html><head><title>BT-Fetch</title></head><body><div><p>${await app.removeAddress(body.address)}</p></div></body></html>`]
                                } else {
                                    mainData = [JSON.stringify(await app.removeAddress(body.address))]
                                }
                                // mainData = [await app.removeAddress(body.address)]
                                if(prog.has(body.address)){
                                    prog.delete(body.address)
                                }
                            } else if(body.title){
                                if(req.mainReq){
                                    mainData = [`<html><head><title>BT-Fetch</title></head><body><div><p>${await app.removeTitle(body.title)}</p></div></body></html>`]
                                } else {
                                    mainData = [JSON.stringify(await app.removeTitle(body.title))]
                                }
                                // mainData = [await app.removeTitle(body.title)]
                                if(prog.has(body.title)){
                                    prog.delete(body.title)
                                }
                            }
                            checkCode = 200
                        }
                        res.data = mainData
                        res.statusCode = checkCode
                        res.headers['Content-Type'] = req.mainRes
                    } else {
                        if(req.mainQuery.length === 64){
                            if(req.mainReq){
                                mainData = [`<html><head><title>BT-Fetch</title></head><body><div><p>${app.stopAddress(req.mainQuery)}</p></div></body></html>`]
                            } else {
                                mainData = [JSON.stringify(app.stopAddress(req.mainQuery))]
                            }
                            // mainData = [app.stopAddress(req.mainQuery)]
                            if(prog.has(req.mainQuery)){
                                prog.delete(req.mainQuery)
                            }
                        } else if(req.mainQuery.length === 40){
                            if(req.mainReq){
                                mainData = [`<html><head><title>BT-Fetch</title></head><body><div><p>${app.stopHash(req.mainQuery)}</p></div></body></html>`]
                            } else {
                                mainData = [JSON.stringify(app.stopHash(req.mainQuery))]
                            }
                            // mainData = [app.stopHash(req.mainQuery)]
                            if(prog.has(req.mainQuery)){
                                prog.delete(req.mainQuery)
                            }
                        } else if(req.mainQuery.length === 32){
                            if(req.mainReq){
                                mainData = [`<html><head><title>BT-Fetch</title></head><body><div><p>${app.stopTitle(req.mainQuery)}</p></div></body></html>`]
                            } else {
                                mainData = [JSON.stringify(app.stopTitle(req.mainQuery))]
                            }
                            // mainData = [app.stopTitle(req.mainQuery)]
                            if(prog.has(req.mainQuery)){
                                prog.delete(req.mainQuery)
                            }
                        }
                        res.data = mainData
                        res.statusCode = 200
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
        return {mainQuery, mainHost, mainPath, mainMethod, mainReg, mainReq, mainRes, mainType}
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
