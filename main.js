const WebTorrent = require('webtorrent')
const fs = require('fs-extra')
const path = require('path')
const crypto = require('crypto')
const sha1 = require('simple-sha1')
const ed = require('ed25519-supercop')
const bencode = require('bencode')
// const EventEmitter = require('events').EventEmitter

const BTPK_PREFIX = 'urn:btpk:'
function encodeSigData (msg) {
  const ref = { seq: msg.seq, v: msg.v }
  if (msg.salt) ref.salt = msg.salt
  return bencode.encode(ref).slice(1, -1)
}
const checkHash = new RegExp('^[a-fA-F0-9]{40}$')
const checkAddress = new RegExp('^[a-fA-F0-9]{64}$')
const checkTitle = new RegExp('^[a-f0-9]{32}$')
const defOpts = {folder: __dirname, storage: 'storage', author: 'author', external: 'external', internal: 'internal', timeout: 60000, share: false, current: true, initial: true}

async function keepUpdated(self){
    self._readyToGo = false
    for(let i = 0;i < self.webtorrent.torrents.length;i++){
        if(self.webtorrent.torrents[i].address){
            try {
                await self.bothGetPut(self.webtorrent.torrents[i])
            } catch (error) {
                console.log(error)
            }
            await new Promise((resolve, reject) => setTimeout(resolve, 5000))
        }
    }
    self._readyToGo = true
}

async function startUp(self){
    // if(self._status.clear){
    //     try {
    //         await fs.emptyDir(self._external)
    //         await fs.emptyDir(self._internal)
    //         await fs.emptyDir(self._author)
    //     } catch (error) {
    //         console.log(error)
    //     }
    // }
    if(self._status.initial){
        let checkInternal = await fs.readdir(self._internal, {withFileTypes: false})
        for(let i = 0;i < checkInternal.length;i++){
            let folderPath = self._internal + path.sep + checkInternal[i]
            if(checkAddress.test(checkInternal[i])){
                // if(self.findTheAddress(checkInternal[i])){
                //     continue
                // }
                let checkTorrent = await Promise.any([
                    new Promise((resolve, reject) => {
                        setTimeout(() => {resolve(null)}, self._status.timeout)
                    }),
                    new Promise((resolve, reject) => {
                        self.webtorrent.seed(folderPath, {destroyStoreOnDestroy: true}, torrent => {
                            resolve(torrent)
                        })
                    })
                ])
                if(checkTorrent){
                    checkTorrent.folder = folderPath
                    let checkProperty = await Promise.any([
                        new Promise((resolve, reject) => {setTimeout(() => {resolve(null)}, self._status.timeout)}),
                        new Promise((resolve, reject) => {
                            self.ownData(checkInternal[i], checkTorrent.infoHash).then(res => {
                                resolve(res)
                            }).catch(error => {
                                console.log(error)
                                self.webtorrent.remove(checkTorrent.infoHash, {destroyStore: false})
                                resolve(null)
                            })
                        })
                    ])
                    if(checkProperty){
                        delete checkProperty.infoHash
                        for(const prop in checkProperty){
                            checkTorrent[prop] = checkProperty[prop]
                        }
                        checkTorrent.folder = folderPath
                        checkTorrent.side = true
                        console.log(checkInternal[i] + ' is good')
                    }
                }
            } else if(checkTitle.test(checkInternal[i])){
                // if(self.findTheTitle(checkInternal[i])){
                //     continue
                // }
                let checkTorrent = await Promise.any([
                    new Promise((resolve, reject) => {
                        setTimeout(() => {resolve(null)}, self._status.timeout)
                    }),
                    new Promise((resolve, reject) => {
                        self.webtorrent.seed(folderPath, {destroyStoreOnDestroy: true}, torrent => {
                            resolve(torrent)
                        })
                    })
                ])
                if(checkTorrent){
                    checkTorrent.folder = folderPath
                    checkTorrent.title = checkInternal[i]
                    checkTorrent.side = true
                    console.log(checkInternal[i] + ' is good')
                }
            } else {
                await fs.remove(folderPath)
            }
        }
    }
    if(self._status.share){
        let checkExternal = await fs.readdir(self._external, {withFileTypes: false})
        for(let i = 0;i < checkExternal.length;i++){
            let folderPath = self._external + path.sep + checkExternal[i]
            if(checkAddress.test(checkExternal[i])){
                // if(self.findTheAddress(checkExternal[i])){
                //     continue
                // }
                let checkProperty = await Promise.any([
                    new Promise((resolve, reject) => {setTimeout(() => {resolve(null)}, self._status.timeout)}),
                    self.resolve(checkExternal[i])
                ])
                if(checkProperty){
                    if(self._status.current){
                        if(!await fs.pathExists(folderPath + path.sep + checkProperty.infoHash)){
                            try {
                                await fs.emptyDir(folderPath)
                            } catch (error) {
                                console.log(error)
                            }
                        }
                    } else if(!self._status.current){
                        try {
                            await fs.ensureDir(folderPath)
                        } catch (error) {
                            console.log(error)
                        }
                    }
                    let checkTorrent = await Promise.any([
                        new Promise((resolve, reject) => {setTimeout(() => {resolve(null)}, self._status.timeout)}),
                        new Promise((resolve, reject) => {
                            self.webtorrent.add(checkProperty.infoHash, {path: folderPath + path.sep + checkProperty.infoHash, destroyStoreOnDestroy: true}, torrent => {
                                resolve(torrent)
                            })
                        })
                    ])
                    if(checkTorrent){
                        checkTorrent.folder = folderPath
                        checkTorrent.side = false
                        delete checkProperty.infoHash
                        for(const prop in checkProperty){
                            checkTorrent[prop] = checkProperty[prop]
                        }
                        console.log(checkExternal[i] + ' is good')
                    }
                }
            } else if(checkHash.test(checkExternal[i])){
                // if(self.findTheHash(checkExternal[i])){
                //     continue
                // }
                let checkTorrent = await Promise.any([
                    new Promise((resolve, reject) => {setTimeout(() => {resolve(null)}, self._status.timeout)}),
                    new Promise((resolve, reject) => {
                        self.webtorrent.add(checkExternal[i], {path: folderPath, destroyStoreOnDestroy: true}, torrent => {
                            resolve(torrent)
                        })
                    })
                ])
                if(checkTorrent){
                    checkTorrent.folder = folderPath
                    checkTorrent.side = false
                    checkTorrent.title = crypto.createHash('md5').update(checkExternal[i]).digest("hex")
                    console.log(checkExternal[i] + ' is good')
                }
            } else {
                await fs.remove(folderPath)
            }
        }
    }
}

class Main {
    constructor(opts = {}){
        const finalOpts = {...defOpts, ...opts}
        finalOpts.folder = path.resolve(finalOpts.folder)
        fs.ensureDirSync(finalOpts.folder)

        this._status = {current: finalOpts.current, share: finalOpts.share, timeout: finalOpts.timeout, initial: finalOpts.initial}
        this._storage = finalOpts.folder + path.sep + finalOpts.storage
        this._external = this._storage + path.sep + finalOpts.external
        this._internal = this._storage + path.sep + finalOpts.internal
        this._author = finalOpts.folder + path.sep + finalOpts.author
        if(!fs.pathExistsSync(this._storage)){
            fs.ensureDirSync(this._storage)
        }
        if(!fs.pathExistsSync(this._external)){
            fs.ensureDirSync(this._external)
        }
        if(!fs.pathExistsSync(this._internal)){
            fs.ensureDirSync(this._internal)
        }
        if(!fs.pathExistsSync(this._author)){
            fs.ensureDirSync(this._author)
        }
        this.webtorrent = new WebTorrent({dht: {verify: ed.verify}})
        this.webtorrent.on('error', error => {
            console.log(error)
        })
        this._readyToGo = true
        startUp(this).catch(error => {console.log(error)})
        setInterval(() => {
            if(this._readyToGo){
                keepUpdated(this).catch(error => {console.log(error)})
            }
        }, 3600000)
    }

    async ownData(address, infoHash){
        if(!await fs.pathExists(this._author + path.sep + address)){
            throw new Error('data was not found')
        }
        let data = await fs.readFile(this._author + path.sep + address)
        data = JSON.parse(data.toString())
        if(infoHash !== data.infoHash || !ed.verify(Buffer.from(data.sig, 'hex'), encodeSigData({seq: data.sequence, v: {ih: infoHash, ...data.stuff}}), Buffer.from(data.address, 'hex'))){
          throw new Error('data does not match signature')
        }
        return data
      }

    async resolve(address){
        if(!address || typeof(address) !== 'string'){
            throw new Error('address can not be parsed')
        }
        const addressKey = Buffer.from(address, 'hex')
        return await new Promise((resolve, reject) => {
            sha1(addressKey, (targetID) => {
                this.webtorrent.dht.get(targetID, (err, res) => {
                    if(err){
                    reject(err)
                    } else if(res){
                    if(!checkHash.test(res.v.ih.toString('utf-8')) || !Number.isInteger(res.seq)){
                        reject(new Error('data is invalid'))
                    }
                    for(const prop in res.v){
                        res.v[prop] = res.v[prop].toString('utf-8')
                    }
                    let {ih, ...stuff} = res.v
                    resolve({magnet: `magnet:?xs=${BTPK_PREFIX}${address}`, address, infoHash: ih, sequence: res.seq, stuff, sig: res.sig.toString('hex'), side: false, netdata: res})
                    } else if(!res){
                    reject(new Error('Could not resolve address'))
                    }
                })
            })
        })
      }

      async publish(address, secret, text){
            for(let prop in text){
              if(typeof(text[prop]) !== 'string'){
                this.webtorrent.remove(text.ih, {destroyStore: false})
                throw new Error('text data must be strings')
              }
            }
            if(!checkHash.test(text.ih)){
                this.webtorrent.remove(text.ih, {destroyStore: false})
              throw new Error('must have infohash')
            }
            if(!address || !secret){
                this.webtorrent.remove(text.ih, {destroyStore: false})
              throw new Error('must have address and secret')
            }
        
            const buffAddKey = Buffer.from(address, 'hex')
            const buffSecKey = secret ? Buffer.from(secret, 'hex') : null
            const v = text
            const buffSig = ed.sign(encodeSigData({seq, v}), buffAddKey, buffSecKey)
      
            let data = null
            let seq = null
            if(await fs.pathExists(this._author + path.sep + address)){
              data = await fs.readFile(this._author + path.sep + address)
              data = JSON.parse(data.toString())
              seq = data.sequence + 1
            } else {
              seq = 0
            }
            let putData = await new Promise((resolve, reject) => {
                this.webtorrent.dht.put({k: buffAddKey, v, seq, sig: buffSig}, (putErr, hash, number) => {
                    if(putErr){
                        this.webtorrent.remove(text.ih, {destroyStore: false})
                        reject(putErr)
                    } else {
                        resolve({hash: hash.toString('hex'), number})
                    }
                })
            })
            let {ih, ...stuff} = text
            let main = {magnet: `magnet:?xs=${BTPK_PREFIX}${address}`, address, infoHash: ih, sequence: seq, stuff, sig: buffSig.toString('hex'), side: true, ...putData}
            await fs.writeFile(this._author + path.sep + address, JSON.stringify(main))
            return main
      }

      bothGetPut(data){
        return new Promise((resolve, reject) => {
          const buffAddKey = Buffer.from(data.address, 'hex')
          const buffSigData = Buffer.from(data.sig, 'hex')
          sha1(buffAddKey, (targetID) => {
      
            this.webtorrent.dht.get(targetID, (getErr, getData) => {
              if(getErr){
                console.log(getErr)
              }
              if(getData){
                this.webtorrent.dht.put(getData, (putErr, hash, number) => {
                  if(putErr){
                    reject(putErr)
                  } else {
                    resolve({getData, putData: {hash: hash.toString('hex'), number}})
                  }
                })
              } else if(!getData){
                this.webtorrent.dht.put({k: buffAddKey, v: {ih: data.infoHash, ...data.stuff}, seq: data.sequence, sig: buffSigData}, (putErr, hash, number) => {
                  if(putErr){
                    reject(putErr)
                  } else {
                    resolve({hash: hash.toString('hex'), number})
                  }
                })
              }
            })
          })
        })
      }
    
      saveData(data){
        return new Promise((resolve, reject) => {
          this.webtorrent.dht.put({k: Buffer.from(data.address, 'hex'), v: {ih: data.infoHash, ...data.stuff}, seq: data.sequence, sig: Buffer.from(data.sig, 'hex')}, (error, hash, number) => {
            if(error){
              reject(error)
            } else {
              resolve({hash: hash.toString('hex'), number})
            }
          })
        })
      }
    
      keepCurrent(address){
        return new Promise((resolve, reject) => {
          const buffAddKey = Buffer.from(address, 'hex')
    
          sha1(buffAddKey, (targetID) => {
      
            this.webtorrent.dht.get(targetID, (getErr, getData) => {
              if (getErr) {
                reject(getErr)
              } else if(getData){
                this.webtorrent.dht.put(getData, (putErr, hash, number) => {
                  if(putErr){
                    reject(putErr)
                  } else {
                    resolve({getData, putData: {hash: hash.toString('hex'), number}})
                  }
                })
              } else if(!getData){
                reject(new Error('could not find property'))
              }
            })
          })
        })
      }
    
      createKeypair () {
        let {publicKey, secretKey} = ed.createKeyPair(ed.createSeed())
    
        return { address: publicKey.toString('hex'), secret: secretKey.toString('hex') }
      }
    
      addressFromLink(link){
        if(!link || typeof(link) !== 'string'){
          return ''
        } else if(link.startsWith('bt')){
          try {
            const parsed = new URL(link)
        
            if(!parsed.hostname){
              return ''
            } else {
              return parsed.hostname
            }
    
          } catch (error) {
            console.log(error)
            return ''
          }
        } else if(link.startsWith('magnet')){
          try {
            const parsed = new URL(link)
    
            const xs = parsed.searchParams.get('xs')
      
            const isMutableLink = xs && xs.startsWith(BTPK_PREFIX)
        
            if(!isMutableLink){
              return ''
            } else {
              return xs.slice(BTPK_PREFIX.length)
            }
    
          } catch (error) {
            console.log(error)
            return ''
          }
        } else {
          return ''
        }
      }

    async shred(address){
        if(await fs.pathExists(this._author + path.sep + address)){
          await fs.remove(this._author + path.sep + address)
          return true
        } else {
          return false
        }
      }

    async ownTitle(title){
        let haveTorrent = this.findTheTitle(title)
        if(haveTorrent){
            return haveTorrent
        }
        let folderPath = this._internal + path.sep + title
        if(!await fs.pathExists(folderPath)){
            throw new Error('folder does not exist')
        }
        checkTorrent = await Promise.race([
            new Promise((resolve, reject) => {
                setTimeout(() => {reject(new Error(title + ' took too long, it timed out'))}, this._status.timeout)
            }),
            new Promise((resolve, reject) => {
                this.webtorrent.seed(folderPath, {destroyStoreOnDestroy: true}, torrent => {
                    resolve(torrent)
                })
            })
        ])
        checkTorrent.folder = folderPath
        checkTorrent.title = title
        checkTorrent.side = true
        return checkTorrent
    }

    async ownAddress(address){
        let haveTorrent = this.findTheAddress(address)
        if(haveTorrent){
            return haveTorrent
        }
        let folderPath = this._internal + path.sep + address
        if(!await fs.pathExists(folderPath)){
            throw new Error('folder does not exist')
        }
        let checkTorrent = await Promise.race([
            new Promise((resolve, reject) => {
                setTimeout(() => {reject(new Error(address + ' took too long, it timed out'))}, this._status.timeout)
            }),
            new Promise((resolve, reject) => {
                this.webtorrent.seed(folderPath, {destroyStoreOnDestroy: true}, torrent => {
                    resolve(torrent)
                })
            })
        ])
        let checkProperty = await Promise.race([
            new Promise((resolve, reject) => {
                setTimeout(() => {
                    this.webtorrent.remove(checkTorrent.infoHash, {destroyStore: false})
                    reject(new Error(address + ' property took too long, it timed out, please try again with only the keypair without the folder'))
                },this._status.timeout)
            }),
            new Promise((resolve, reject) => {
                this.ownData(address, checkTorrent.infoHash).then(res => {
                    resolve(res)
                }).catch(error => {
                    console.log(error)
                    this.webtorrent.remove(checkTorrent.infoHash, {destroyStore: false})
                    reject(error)
                })
            })
        ])
        delete checkProperty.infoHash
        checkProperty.folder = folderPath
        checkProperty.side = true
        for(const prop in checkProperty){
            checkTorrent[prop] = checkProperty[prop]
        }
        return checkTorrent
    }

    async loadHash(hash){
        let haveTorrent = this.findTheHash(hash)
        if(haveTorrent){
            return haveTorrent
        }
        // if user had torrent before, then empty the folder so previous data does notconflict with the infohash
        let folderPath = this._external + path.sep + hash
        // try {
        //     await fs.emptyDir(folderPath)
        // } catch (error) {
        //     console.log(error)
        // }
        checkTorrent = await Promise.race([
            new Promise((resolve, reject) => {
                setTimeout(() => {reject(new Error(hash + ' took too long, it timed out'))}, this._status.timeout)
            }),
            new Promise((resolve, reject) => {
                this.webtorrent.add(hash, {path: folderPath, destroyStoreOnDestroy: true}, torrent => {
                    resolve(torrent)
                })
            })
        ])
        checkTorrent.folder = folderPath
        checkTorrent.side = false
        checkTorrent.title = crypto.createHash('md5').update(hash).digest("hex")
        return checkTorrent
    }

    async publishTitle(folder){
        if(!folder || typeof(folder) !== 'string'){
            throw new Error('path ' + folder + ' does not work')
        } else {
            folder = {oldFolder: path.resolve(folder)}
            folder.target = path.basename(folder.oldFolder)
            folder.hashed = crypto.createHash('md5').update(folder.oldFolder).digest("hex")
            folder.main = this._internal + path.sep + folder.hashed
            folder.newFolder = folder.target.includes('.') ? folder.main + path.sep + folder.target : folder.main
            let haveTorrent = this.findTheTitle(folder.hashed)
            if(haveTorrent){
                return {torrent: haveTorrent, title: haveTorrent.title}
            }
            if(folder.target.includes('.')){
                try {
                    await fs.emptyDir(folder.main)
                } catch (error) {
                    console.log(error)
                }
            }
            await fs.copy(folder.oldFolder, folder.newFolder, {overwrite: true})
        }
        let checkTorrent = await Promise.race([
            new Promise((resolve, reject) => {
                setTimeout(() => {reject(new Error('torrent took too long, it timed out'))}, this._status.timeout)
            }),
            new Promise((resolve, reject) => {
                this.webtorrent.seed(folder.main, {destroyStoreOnDestroy: true}, torrent => {
                    resolve(torrent)
                })
            })
        ])
        checkTorrent.folder = folder.main
        checkTorrent.title = folder.hashed
        checkTorrent.side = true
        return {torrent: checkTorrent, title: checkTorrent.title}
    }

    async loadAddress(address){
        let haveTorrent = this.findTheAddress(address)
        if(haveTorrent){
            return haveTorrent
        }
        let checkProperty = await Promise.race([
            new Promise((resolve, reject) => {
                setTimeout(() => {reject(new Error(address + ' property took too long, it timed out'))}, this._status.timeout)
            }),
            this.resolve(address)
        ])

        checkProperty.folder = this._external + path.sep + checkProperty.address
        checkProperty.side = false

        // if user had this torrent before and data or files were added in this folder, then the site might be messed up, we empty the folder that way the infohash is intact
        if(this._status.current){
            if(!await fs.pathExists(checkProperty.folder + path.sep + checkProperty.infoHash)){
                try {
                    await fs.emptyDir(checkProperty.folder)
                } catch (error) {
                    console.log(error)
                }
            }
        } else if(!this._status.current){
            if(!await fs.pathExists(checkProperty.folder)){
                try {
                    await fs.ensureDir(checkProperty.folder)
                } catch (error) {
                    console.log(error)
                }
            }
        }

        let checkTorrent = await Promise.race([
            new Promise((resolve, reject) => {
                setTimeout(() => {reject(new Error(checkProperty.address + ' took too long, it timed out'))}, this._status.timeout)
            }),
            new Promise((resolve, reject) => {
                this.webtorrent.add(checkProperty.infoHash, {path: checkProperty.folder + path.sep + checkProperty.infoHash, destroyStoreOnDestroy: true}, torrent => {
                    resolve(torrent)
                })
            })
        ])
        delete checkProperty.infoHash
        for(const prop in checkProperty){
            checkTorrent[prop] = checkProperty[prop]
        }
        return checkTorrent
    }
    async publishAddress(folder, keypair){
        if(!keypair || !keypair.address || !keypair.secret){
            keypair = this.createKeypair()
        }
        let haveTorrent = this.findTheAddress(keypair.address)
        if(haveTorrent){
            return {torrent: haveTorrent, secret: null}
        }
        if(!folder || typeof(folder) !== 'string'){
            throw new Error('must have folder')
        } else {
            folder = {oldFolder: path.resolve(folder)}
            folder.main = this._internal + path.sep + keypair.address
            folder.target = path.basename(folder.oldFolder)
            folder.newFolder = folder.target.includes('.') ? folder.main + path.sep + folder.target : folder.main
            if(folder.target.includes('.')){
                try {
                    await fs.emptyDir(folder.main)
                } catch (error) {
                    console.log(error)
                }
            }
            await fs.copy(folder.oldFolder, folder.newFolder, {overwrite: true})
        }
        let checkTorrent = await Promise.race([
            new Promise((resolve, reject) => {
                setTimeout(() => {reject(new Error('torrent took too long, it timed out'))},this._status.timeout)
            }),
            new Promise((resolve, reject) => {
                this.webtorrent.seed(folder.main, {destroyStoreOnDestroy: true}, torrent => {
                    resolve(torrent)
                })
            })
        ])
        let checkProperty = await Promise.race([
            new Promise((resolve, reject) => {
                setTimeout(() => {
                    this.webtorrent.remove(checkTorrent.infoHash, {destroyStore: false})
                    reject(new Error(keypair.address + ' property took too long, it timed out, please try again with only the keypair without the folder'))
                },this._status.timeout)
            }),
            this.publish(keypair.address, keypair.secret, {ih: checkTorrent.infoHash})
        ])
        const tempSecret = checkProperty.secret
        delete checkProperty.infoHash
        delete checkProperty.secret
        checkProperty.folder = folder.main
        checkProperty.side = true
        for(const prop in checkProperty){
            checkTorrent[prop] = checkProperty[prop]
        }
        return {torrent: checkTorrent, secret: tempSecret}
    }
    
    clearData(){
        for(let i = 0;i < this.webtorrent.torrents.length;i++){
            this.webtorrent.remove(this.webtorrent.torrents[i].infoHash, {destroyStore: false})
        }
        return 'data was stopped'
    }

    stopTitle(title){
        let checkTorrent = this.findTheTitle(title)
        if(checkTorrent){
            this.webtorrent.remove(checkTorrent.infoHash, {destroyStore: false})
            return title + ' was stopped'
        } else {
            return title + ' was not found'
        }
    }
    
    async removeTitle(title){
        let checkTorrent = this.findTheTitle(title)
        if(checkTorrent){
            let folder = checkTorrent.folder
            this.webtorrent.remove(checkTorrent.infoHash, {destroyStore: false})
            if(folder){
                try {
                    await fs.remove(folder)
                } catch (error) {
                    console.log(error)
                }
            }
        } else {
            if(await fs.pathExists(this._external + path.sep + title)){
                try {
                    await fs.remove(this._external + path.sep + title)
                } catch (error) {
                    console.log(error)
                }
            }
            if(await fs.pathExists(this._internal + path.sep + title)){
                try {
                    await fs.remove(this._internal + path.sep + title)
                } catch (error) {
                    console.log(error)
                }
            }
        }
        return title + ' has been removed'
    }

    stopHash(hash){
        let checkTorrent = this.findTheHash(hash)
        if(checkTorrent){
            this.webtorrent.remove(checkTorrent.infoHash, {destroyStore: false})
            return hash + ' was stopped'
        } else {
            return hash + ' was not found'
        }
    }
    
    async removeHash(hash){
        let checkTorrent = this.findTheHash(hash)
        if(checkTorrent){
            let folder = checkTorrent.folder
            this.webtorrent.remove(checkTorrent.infoHash, {destroyStore: false})
            if(folder){
                try {
                    await fs.remove(folder)
                } catch (error) {
                    console.log(error)
                }
            }
        } else {
            if(await fs.pathExists(this._external + path.sep + hash)){
                try {
                    await fs.remove(this._external + path.sep + hash)
                } catch (error) {
                    console.log(error)
                }
            }
            if(await fs.pathExists(this._internal + path.sep + hash)){
                try {
                    await fs.remove(this._internal + path.sep + hash)
                } catch (error) {
                    console.log(error)
                }
            }
        }
        return hash + ' has been removed'
    }
    stopAddress(address){
        let checkTorrent = this.findTheAddress(address)
        if(checkTorrent){
            this.webtorrent.remove(checkTorrent.infoHash, {destroyStore: false})
            return address + ' was stopped'   
        } else {
            return address + ' was not found'
        }
    }
    async removeAddress(address){
        let checkedTorrent = this.findTheAddress(address)
        if(checkedTorrent){
            let folder = checkedTorrent.folder
            let side = checkedTorrent.side
            this.webtorrent.remove(checkedTorrent.infoHash, {destroyStore: false})
            if(folder){
                try {
                    await fs.remove(folder)
                } catch (error) {
                    console.log(error)
                }
            }
            if(side){
                try {
                    await fs.remove(this._author + path.sep + address)
                } catch (error) {
                    console.log(error)
                }
            }
        } else {
            if(await fs.pathExists(this._external + path.sep + address)){
                try {
                    await fs.remove(this._external + path.sep + address)
                } catch (error) {
                    console.log(error)
                }
            }
            if(await fs.pathExists(this._internal + path.sep + address)){
                try {
                    await fs.remove(this._internal + path.sep + address)
                } catch (error) {
                    console.log(error)
                }
            }
            if(await fs.pathExists(this._author + path.sep + address)){
                await fs.remove(this._author + path.sep + address)
              }
        }
        return address + ' was removed'
    }
    findTheFolder(folder){
        let tempTorrent = null
        for(let i = 0;i < this.webtorrent.torrents.length;i++){
            if(this.webtorrent.torrents[i].folder === folder){
                tempTorrent = this.webtorrent.torrents[i]
                break
            }
        }
        return tempTorrent
    }
    findTheTitle(title){
        let tempTorrent = null
        for(let i = 0;i < this.webtorrent.torrents.length;i++){
            if(this.webtorrent.torrents[i].title === title){
                tempTorrent = this.webtorrent.torrents[i]
                break
            }
        }
        return tempTorrent
    }
    findTheHash(hash){
        let tempTorrent = null
        for(let i = 0;i < this.webtorrent.torrents.length;i++){
            if(this.webtorrent.torrents[i].infoHash === hash){
                tempTorrent = this.webtorrent.torrents[i]
                break
            }
        }
        return tempTorrent
    }
    findTheAddress(address){
        let tempTorrent = null
        for(let i = 0;i < this.webtorrent.torrents.length;i++){
            if(this.webtorrent.torrents[i].address === address){
                tempTorrent = this.webtorrent.torrents[i]
                break
            }
        }
        return tempTorrent
    }
}

module.exports = Main