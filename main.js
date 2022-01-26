const WebTorrent = require('webtorrent')
const fs = require('fs-extra')
const path = require('path')
const crypto = require('crypto')
const sha1 = require('simple-sha1')
const ed = require('ed25519-supercop')
const bencode = require('bencode')
const busboy = require('busboy')
const { Readable } = require('stream')
const {EventIterator} = require('event-iterator')
// const EventEmitter = require('events').EventEmitter

const BTPK_PREFIX = 'urn:btpk:'

// saves us from saving secret keys(saving secret keys even encrypted secret keys is something i want to avoid)
// with this function which was taken from the bittorrent-dht package
// we save only the signatures when we first publish a BEP46 torrent
function encodeSigData (msg) {
  const ref = { seq: msg.seq, v: msg.v }
  if (msg.salt) ref.salt = msg.salt
  return bencode.encode(ref).slice(1, -1)
}

// setting up constants
const checkHash = new RegExp('^[a-fA-F0-9]{40}$')
const checkAddress = new RegExp('^[a-fA-F0-9]{64}$')
const defOpts = { folder: __dirname, storage: 'storage', author: 'author', external: 'external', internal: 'internal', timeout: 60000, share: false, current: true, initial: true }

class Main {
  constructor (opts = {}) {
    const finalOpts = { ...defOpts, ...opts }
    this._current = finalOpts.current
    this._share = finalOpts.share
    this._timeout = finalOpts.timeout
    this._initial = finalOpts.initial

    finalOpts.folder = path.resolve(finalOpts.folder)
    fs.ensureDirSync(finalOpts.folder)

    this._folder = finalOpts.folder
    this._storage = this._folder + path.sep + finalOpts.storage
    this._external = this._storage + path.sep + finalOpts.external
    this._internal = this._storage + path.sep + finalOpts.internal
    this._author = this._folder + path.sep + finalOpts.author
    if (!fs.pathExistsSync(this._storage)) {
      fs.ensureDirSync(this._storage)
    }
    if (!fs.pathExistsSync(this._external)) {
      fs.ensureDirSync(this._external)
    }
    if (!fs.pathExistsSync(this._internal)) {
      fs.ensureDirSync(this._internal)
    }
    if (!fs.pathExistsSync(this._author)) {
      fs.ensureDirSync(this._author)
    }
    this.webtorrent = new WebTorrent({ dht: { verify: ed.verify } })
    this.webtorrent.on('error', error => {
      console.log(error)
    })
    this._readyToGo = true

    // run the start up function
    this.startUp().catch(error => { console.log(error) })

    // run the keepUpdated function every 1 hour, it keep the data active by putting the data back into the dht, don't run it if it is still working from the last time it ran the keepUpdated function
    this.updateRoutine = setInterval(() => {
      if (this._readyToGo) {
        this.keepUpdated().catch(error => { console.log(error) })
      }
    }, 3600000)
  }

// keep data active in the dht, runs every hour
async keepUpdated () {
  this._readyToGo = false
  for (const torrent of this.webtorrent.torrents) {
    if (torrent.address) {
      try {
        await this.bothGetPut(torrent)
      } catch (error) {
        console.log(error)
      }
      await new Promise((resolve, reject) => setTimeout(resolve, 5000))
    }
  }
  this._readyToGo = true
}

// -------------------------------------
// start up functions runs on every start up
// -------------------------------------------
async startUp () {
  // a mechanism to clear all data meaning delete all user-created torrents, all non-user created torrents, and all BEP46 publishing data, most likely too extreme and not needed

  // if(this._clear){
  //     try {
  //         await fs.emptyDir(this._external)
  //         await fs.emptyDir(this._internal)
  //         await fs.emptyDir(this._author)
  //     } catch (error) {
  //         console.log(error)
  //     }
  // }

  // if initial option is true, then start seeding all user created torrents on start up
  if (this._initial) {
    const checkInternal = await fs.readdir(this._internal, { withFileTypes: false })
    for (const checkInternalPath of checkInternal) {
      const folderPath = path.join(this._internal, checkInternalPath)
      if (checkAddress.test(checkInternalPath)) {
        const checkTorrent = await Promise.any([
          this.delayTimeOut(this._timeout, null, true),
          new Promise((resolve, reject) => {
            this.webtorrent.seed(folderPath, { destroyStoreOnDestroy: true }, torrent => {
              resolve(torrent)
            })
          })
        ])
        if (checkTorrent) {
          checkTorrent.folder = folderPath
          const checkProperty = await Promise.any([
            this.delayTimeOut(this._timeout, null, true),
            new Promise((resolve, reject) => {
              this.ownData(checkInternalPath, checkTorrent.infoHash).then(res => {
                resolve(res)
              }).catch(error => {
                console.log(error)
                // most likely the infohash of this torrent does not match what we have currently, stop this torrent
                this.webtorrent.remove(checkTorrent.infoHash, { destroyStore: false })
                resolve(null)
              })
            })
          ])
          if (checkProperty) {
            // don't overwrite the torrent's infohash even though they will both be the same
            delete checkProperty.infoHash
            for (const prop in checkProperty) {
              checkTorrent[prop] = checkProperty[prop]
            }
            checkTorrent.folder = folderPath
            checkTorrent.side = true
            console.log(checkInternalPath + ' is good')
          }
        }
      } else if (checkHash.test(checkInternalPath)) {
        const checkTorrent = await Promise.any([
          this.delayTimeOut(this._timeout, null, true),
          new Promise((resolve, reject) => {
            this.webtorrent.seed(folderPath, { destroyStoreOnDestroy: true }, torrent => {
              resolve(torrent)
            })
          })
        ])
        if (checkTorrent) {
          checkTorrent.folder = folderPath
          checkTorrent.hash = checkInternalPath
          checkTorrent.side = true
          console.log(checkInternalPath + ' is good')
        }
      } else {
        await fs.remove(folderPath)
      }
    }
  }

  // if share option is true, then start seeding(webtorrent.add seeds after torrent is downloaded) on start up
  if (this._share) {
    const checkExternal = await fs.readdir(this._external, { withFileTypes: false })
    for (const checkExternalPath of checkExternal) {
      const folderPath = path.join(this._external, checkExternalPath)
      if (checkAddress.test(checkExternalPath)) {
        const checkProperty = await Promise.any([
          this.delayTimeOut(this._timeout, null, true),
          this.resolve(checkExternalPath)
        ])
        if (checkProperty) {
          if (this._current) {
            if (!await fs.pathExists(folderPath + path.sep + checkProperty.infoHash)) {
              try {
                await fs.emptyDir(folderPath)
              } catch (error) {
                console.log(error)
              }
            }
          } else if (!this._current) {
            try {
              await fs.ensureDir(folderPath)
            } catch (error) {
              console.log(error)
            }
          }
          const checkTorrent = await Promise.any([
            this.delayTimeOut(this._timeout, null, true),
            new Promise((resolve, reject) => {
              this.webtorrent.add(checkProperty.infoHash, { path: folderPath + path.sep + checkProperty.infoHash, destroyStoreOnDestroy: true }, torrent => {
                resolve(torrent)
              })
            })
          ])
          if (checkTorrent) {
            checkTorrent.folder = folderPath
            checkTorrent.side = false
            // don't overwrite the torrent's infohash even though they will both be the same
            delete checkProperty.infoHash
            for (const prop in checkProperty) {
              checkTorrent[prop] = checkProperty[prop]
            }
            console.log(checkExternalPath + ' is good')
          }
        }
      } else if (checkHash.test(checkExternalPath)) {
        const checkTorrent = await Promise.any([
          this.delayTimeOut(this._timeout, null, true),
          new Promise((resolve, reject) => {
            this.webtorrent.add(checkExternalPath, { path: folderPath, destroyStoreOnDestroy: true }, torrent => {
              resolve(torrent)
            })
          })
        ])
        if (checkTorrent) {
          checkTorrent.folder = folderPath
          checkTorrent.side = false
          checkTorrent.hash = checkExternalPath
          console.log(checkExternalPath + ' is good')
        }
      } else {
        await fs.remove(folderPath)
      }
    }
  }
}

delayTimeOut(timeout, data, res){
  return new Promise((resolve, reject) => {setTimeout(() => {if(res){resolve(data)} else {reject(data)}}, timeout)})
  // if(res){
  //   return new Promise((resolve, reject) => {
  //     setTimeout(() => {
  //       resolve(data)
  //     }, timeout)
  //   })
  // } else {
  //   return new Promise((resolve, reject) => {
  //     setTimeout(() => {
  //       reject(data)
  //     }, timeout)
  //   })
  // }
}

  // when we resume or seed a user created BEP46 torrent that has already been created before
  // we have to check that the infohash of the torrent(remember we do not know the infohash before) matches the signature
  // if it does not match, that means the data/torrent has been corrupted somehow
  async ownData (address, infoHash) {
    if (!await fs.pathExists(this._author + path.sep + address)) {
      throw new Error('data was not found')
    }
    // get data from file
    let data = await fs.readFile(this._author + path.sep + address)
    // parse the data file
    data = JSON.parse(data.toString())

    const signatureBuff = Buffer.from(data.sig, 'hex')
    const encodedSignatureData = encodeSigData({ seq: data.sequence, v: { ih: infoHash, ...data.stuff } })
    const addressBuff = Buffer.from(data.address, 'hex')

    if (infoHash !== data.infoHash || !ed.verify(signatureBuff, encodedSignatureData, addressBuff)) {
      throw new Error('data does not match signature')
    }
    return data
  }

  // resolve public key address to an infohash
  async resolveFunc (address) {
    if (!address || typeof (address) !== 'string') {
      throw new Error('address can not be parsed')
    }
    const addressKey = Buffer.from(address, 'hex')
    const getData = await new Promise((resolve, reject) => {
      sha1(addressKey, (targetID) => {
        this.webtorrent.dht.get(targetID, (err, res) => {
          if (err) {
            reject(err)
          } else if (res) {
            resolve(res)
          } else if (!res) {
            reject(new Error('Could not resolve address'))
          }
        })
      })
    })
    if (!checkHash.test(getData.v.ih.toString('utf-8')) || !Number.isInteger(getData.seq)) {
      throw new Error('data is invalid')
    }
    for (const prop in getData.v) {
      getData.v[prop] = getData.v[prop].toString('utf-8')
    }
    const { ih, ...stuff } = getData.v
    return { magnet: `magnet:?xs=${BTPK_PREFIX}${address}`, address, infoHash: ih, sequence: getData.seq, stuff, sig: getData.sig.toString('hex'), side: false, from: getData.id.toString('hex') }
  }

  // publish an infohash under a public key address in the dht
  async publishFunc (address, secret, text) {
    for (const prop in text) {
      if (typeof (text[prop]) !== 'string') {
        throw new Error('text data must be strings')
      }
    }
    if (!checkHash.test(text.ih)) {
      throw new Error('must have infohash')
    }
    if (!address || !secret) {
      throw new Error('must have address and secret')
    }

    const buffAddKey = Buffer.from(address, 'hex')
    const buffSecKey = secret ? Buffer.from(secret, 'hex') : null
    const v = text

    let main = null
    let seq = null
    if (await fs.pathExists(this._author + path.sep + address)) {
      main = await fs.readFile(this._author + path.sep + address)
      main = JSON.parse(data.toString())
      seq = main.sequence + 1
    } else {
      seq = 0
    }

    const buffSig = ed.sign(encodeSigData({ seq, v }), buffAddKey, buffSecKey)

    const putData = await new Promise((resolve, reject) => {
      this.webtorrent.dht.put({ k: buffAddKey, v, seq, sig: buffSig }, (putErr, hash, number) => {
        if (putErr) {
          reject(putErr)
        } else {
          resolve({ hash: hash.toString('hex'), number })
        }
      })
    })
    const { ih, ...stuff } = text
    main = { magnet: `magnet:?xs=${BTPK_PREFIX}${address}`, address, infoHash: ih, sequence: seq, stuff, sig: buffSig.toString('hex'), side: true, ...putData }
    await fs.writeFile(this._author + path.sep + address, JSON.stringify(main))
    return main
  }

  // async shred(address){
  //     if(await fs.pathExists(this._author + path.sep + address)){
  //       await fs.remove(this._author + path.sep + address)
  //       return true
  //     } else {
  //       return false
  //     }
  //   }

  // we use this function to seed a non-BEP46 torrent that we have already created before, not really needed but here just for consistency
  async currentHash (hash) {
    const haveTorrent = this.findTheHash(hash)
    if (haveTorrent) {
      return haveTorrent
    }
    const folderPath = path.join(this._internal, hash)
    if (!await fs.pathExists(folderPath)) {
      throw new Error('folder does not exist')
    }
    const checkTorrent = await Promise.race([
      this.delayTimeOut(this._timeout, new Error(hash + ' took too long, it timed out'), false),
      new Promise((resolve, reject) => {
        this.webtorrent.seed(folderPath, { destroyStoreOnDestroy: true }, torrent => {
          resolve(torrent)
        })
      })
    ])
    checkTorrent.folder = folderPath
    checkTorrent.hash = hash
    checkTorrent.side = true
    return checkTorrent
  }

  // we must use this function to seed a BEP46 torrent that we have already published before
  async currentAddress (address) {
    const haveTorrent = this.findTheAddress(address)
    if (haveTorrent) {
      return haveTorrent
    }
    const folderPath = path.join(this._internal, address)
    if (!await fs.pathExists(folderPath)) {
      throw new Error('folder does not exist')
    }
    const checkTorrent = await Promise.race([
      this.delayTimeOut(this._timeout, new Error(address + ' took too long, it timed out'), false),
      new Promise((resolve, reject) => {
        this.webtorrent.seed(folderPath, { destroyStoreOnDestroy: true }, torrent => {
          resolve(torrent)
        })
      })
    ])
    const checkProperty = await Promise.race([
      new Promise((resolve, reject) => {
        this.delayTimeOut(this._timeout, new Error(address + ' property took too long, it timed out, please try again with only the keypair without the folder'), false).catch(error => {
          this.webtorrent.remove(checkTorrent.infoHash, { destroyStore: false })
          reject(error)
        })
      }),
      new Promise((resolve, reject) => {
        this.ownData(address, checkTorrent.infoHash).then(res => {
          resolve(res)
        }).catch(error => {
          console.log(error)
          // most likely the infohash of this torrent does not match what we have, stop this torrent and reject the promise
          this.webtorrent.remove(checkTorrent.infoHash, { destroyStore: false })
          reject(error)
        })
      })
    ])
    // don't overwrite the torrent's infohash even though they will both be the same
    delete checkProperty.infoHash
    checkProperty.folder = folderPath
    checkProperty.side = true
    for (const prop in checkProperty) {
      checkTorrent[prop] = checkProperty[prop]
    }
    return checkTorrent
  }

  // download a regular non-BEP46 non-user created torrent by entering a 40 character infohash
  async loadHash (hash) {
    const haveTorrent = this.findTheHash(hash)
    if (haveTorrent) {
      return haveTorrent
    }
    // if user had torrent before, then empty the folder so previous data does not conflict with the infohash
    const folderPath = path.join(this._external, hash)
    // try {
    //     await fs.emptyDir(folderPath)
    // } catch (error) {
    //     console.log(error)
    // }
    const checkTorrent = await Promise.race([
      this.delayTimeOut(this._timeout, new Error(hash + ' took too long, it timed out'), false),
      new Promise((resolve, reject) => {
        this.webtorrent.add(hash, { path: folderPath, destroyStoreOnDestroy: true }, torrent => {
          resolve(torrent)
        })
      })
    ])
    checkTorrent.folder = folderPath
    checkTorrent.side = false
    checkTorrent.hash = checkTorrent.infoHash
    return checkTorrent
  }

  // publish a regular non-BEP46 torrent, we need a path to the directory where the data is
  // we copy it to a new sub-directory(inside the this._internal directory)
  // that will have a 32 character md5 hash as it's sub-directory name
  // we do this because we can not name it with the infohash
  // because we do not know the infohash of this torrent beforehand
  // we return the torrent along with the title
  // that way the user knows the title when they want to start the torrent
  async publishHash (hash, headers, data) {
    if(hash){
      this.stopHash(hash)
    } else {
      hash = crypto.createHash('sha1').update(crypto.randomBytes(20).toString('hex')).digest('hex')
    }
    const folderPath = path.join(this._internal, hash)
    await this.handleFormData(folderPath, headers, data)
    const checkTorrent = await Promise.race([
      this.delayTimeOut(this._timeout, new Error('torrent took too long, it timed out'), false),
      new Promise((resolve, reject) => {
        this.webtorrent.seed(folderPath, { destroyStoreOnDestroy: true }, torrent => {
          resolve(torrent)
        })
      })
    ])
    checkTorrent.folder = folderPath
    checkTorrent.hash = hash
    checkTorrent.side = true
    return { torrent: checkTorrent, hash: checkTorrent.hash }
  }

  // download a non-user created BEP46 torrent by their public key address, non-user meaning someone else's BEP46 torrent
  async loadAddress (address) {
    const haveTorrent = this.findTheAddress(address)
    if (haveTorrent) {
      return haveTorrent
    }
    const checkProperty = await Promise.race([
      this.delayTimeOut(this._timeout, new Error(address + ' property took too long, it timed out'), false),
      this.resolveFunc(address)
    ])

    checkProperty.folder = path.join(this._external, checkProperty.address)
    checkProperty.side = false

    // if current option is true, then if the infohash for the address is brand new then empty the directory and download the new infohash
    // if the current option is false, then at least make sure the main folder which is named with the public key address exists
    if (this._current) {
      if (!await fs.pathExists(checkProperty.folder + path.sep + checkProperty.infoHash)) {
        try {
          await fs.emptyDir(checkProperty.folder)
        } catch (error) {
          console.log(error)
        }
      }
    } else if (!this._current) {
      if (!await fs.pathExists(checkProperty.folder)) {
        try {
          await fs.ensureDir(checkProperty.folder)
        } catch (error) {
          console.log(error)
        }
      }
    }

    const checkTorrent = await Promise.race([
      this.delayTimeOut(this._timeout, new Error(checkProperty.address + ' took too long, it timed out'), false),
      new Promise((resolve, reject) => {
        this.webtorrent.add(checkProperty.infoHash, { path: checkProperty.folder + path.sep + checkProperty.infoHash, destroyStoreOnDestroy: true }, torrent => {
          resolve(torrent)
        })
      })
    ])
    // don't overwrite the torrent's infohash even though they will both be the same
    delete checkProperty.infoHash
    for (const prop in checkProperty) {
      checkTorrent[prop] = checkProperty[prop]
    }
    return checkTorrent
  }

  // publish a new BEP46 torrent, or update an address/public key with a new torrent
  // we need a folder(string) passed in as an argument
  // we check we have a torrent already for the public key address
  // we then copy the data from the folder to the this._internal directory
  // we return secret key along with the torrent because the user will need it
  async publishAddress (keypair, headers, data) {
    if (!keypair || !keypair.address || !keypair.secret) {
      keypair = this.createKeypair()
    } else {
      this.stopAddress(keypair.address)
    }
    const folderPath = path.join(this._internal, keypair.address)
    await this.handleFormData(folderPath, headers, data)
    const checkTorrent = await Promise.race([
      this.delayTimeOut(this._timeout, new Error('torrent took too long, it timed out'), false),
      new Promise((resolve, reject) => {
        this.webtorrent.seed(folderPath, { destroyStoreOnDestroy: true }, torrent => {
          resolve(torrent)
        })
      })
    ])
    const checkProperty = await Promise.race([
      new Promise((resolve, reject) => {
        this.delayTimeOut(this._timeout, new Error(keypair.address + ' property took too long, it timed out, please try again with only the keypair without the folder'), false).catch(error => {
          this.webtorrent.remove(checkTorrent.infoHash, { destroyStore: false })
          reject(error)
        })
      }),
      new Promise((resolve, reject) => {
        this.publishFunc(keypair.address, keypair.secret, { ih: checkTorrent.infoHash }).then(res => {
          resolve(res)
        }).catch(error => {
          // if there is an error with publishing to the dht, then stop this torrent and reject the promise
          this.webtorrent.remove(checkTorrent.infoHash, { destroyStore: false })
          reject(error)
        })
      })
    ])
    // don't overwrite the torrent's infohash even though they will both be the same
    delete checkProperty.infoHash
    checkProperty.folder = folderPath
    checkProperty.side = true
    for (const prop in checkProperty) {
      checkTorrent[prop] = checkProperty[prop]
    }
    return { torrent: checkTorrent, secret: keypair.secret }
  }

  // ------------- the below functions are for stopping or removing data and torrents

  // stops all torrents
  clearData () {
    for (let i = 0; i < this.webtorrent.torrents.length; i++) {
      this.webtorrent.remove(this.webtorrent.torrents[i].infoHash, { destroyStore: false })
    }
    return 'data was stopped'
  }

  // stops the torrent with the 40 character infohash(string)
  stopHash (hash) {
    const checkTorrent = this.findTheHash(hash)
    if (checkTorrent) {
      this.webtorrent.remove(checkTorrent.infoHash, { destroyStore: false })
      return hash + ' was stopped'
    } else {
      return hash + ' was not found'
    }
  }

  // stops the torrent with the 64 character public key(string)
  stopAddress (address) {
    const checkTorrent = this.findTheAddress(address)
    if (checkTorrent) {
      this.webtorrent.remove(checkTorrent.infoHash, { destroyStore: false })
      return address + ' was stopped'
    } else {
      return address + ' was not found'
    }
  }

  // stop the torrent with the infohash, then fully remove all data for the torrent, if torrent is not active, then find if we have any data on disk and if we do then delete all that data
  async removeHash (hash) {
    const checkTorrent = this.findTheHash(hash)
    if (checkTorrent) {
      const folder = checkTorrent.folder
      this.webtorrent.remove(checkTorrent.infoHash, { destroyStore: false })
      if (folder) {
        try {
          await fs.remove(folder)
        } catch (error) {
          console.log(error)
        }
      }
    } else {
      if (await fs.pathExists(path.join(this._external, hash))) {
        try {
          await fs.remove(path.join(this._external, hash))
        } catch (error) {
          console.log(error)
        }
      }
      if (await fs.pathExists(path.join(this._internal, hash))) {
        try {
          await fs.remove(path.join(this._internal, hash))
        } catch (error) {
          console.log(error)
        }
      }
    }
    return hash + ' has been removed'
  }

  // stop the torrent with the address, then fully remove all data for the torrent, if torrent is not active, then find if we have any data on disk and if we do then delete all that data
  async removeAddress (address) {
    const checkedTorrent = this.findTheAddress(address)
    if (checkedTorrent) {
      const folder = checkedTorrent.folder
      const side = checkedTorrent.side
      this.webtorrent.remove(checkedTorrent.infoHash, { destroyStore: false })
      if (folder) {
        try {
          await fs.remove(folder)
        } catch (error) {
          console.log(error)
        }
      }
      if (side) {
        try {
          await fs.remove(this._author + path.sep + address)
        } catch (error) {
          console.log(error)
        }
      }
    } else {
      if (await fs.pathExists(path.join(this._external, address))) {
        try {
          await fs.remove(path.join(this._external, address))
        } catch (error) {
          console.log(error)
        }
      }
      if (await fs.pathExists(path.join(this._internal, address))) {
        try {
          await fs.remove(path.join(this._internal, address))
        } catch (error) {
          console.log(error)
        }
      }
      if (await fs.pathExists(this._author + path.sep + address)) {
        await fs.remove(this._author + path.sep + address)
      }
    }
    return address + ' was removed'
  }

  // --------------------- the below functions loops and gets the torrents we are seeking, if it is not found then null is returned
  findTheFolder (folder) {
    let tempTorrent = null
    for (let i = 0; i < this.webtorrent.torrents.length; i++) {
      if (this.webtorrent.torrents[i].folder === folder) {
        tempTorrent = this.webtorrent.torrents[i]
        break
      }
    }
    return tempTorrent
  }

  findTheHash (hash) {
    let tempTorrent = null
    for (let i = 0; i < this.webtorrent.torrents.length; i++) {
      if (this.webtorrent.torrents[i].hash === hash) {
        tempTorrent = this.webtorrent.torrents[i]
        break
      }
    }
    return tempTorrent
  }

  findTheAddress (address) {
    let tempTorrent = null
    for (let i = 0; i < this.webtorrent.torrents.length; i++) {
      if (this.webtorrent.torrents[i].address === address) {
        tempTorrent = this.webtorrent.torrents[i]
        break
      }
    }
    return tempTorrent
  }

  async handleFormData(folderPath, headers, data){
    const bb = busboy({ headers })
    await fs.ensureDir(folderPath)
    
    const toUpload = new EventIterator(({ push, stop, fail }) => {
      function handleRemoval(){
        bb.off('file', handleFiles)
        bb.off('error', handleErrors)
        bb.off('close', handleClose)
      }
      function handleFiles(name, file, info){
        push(fs.writeFile(path.join(folderPath, info.filename), file))
        // const saveTo = fs.createWriteStream(path.join(folderPath, info.filename));
        // file.pipe(saveTo)
      }
      function handleErrors(error){
        handleRemoval()
        fail(error)
      }
      function handleClose(){
        handleRemoval()
        stop()
      }
      busboy.on('error', handleErrors)
      busboy.on('close', handleClose)
      busboy.on('file', handleFiles)

      // TODO: Does busboy need to be GC'd?
      return () => {}
    })

    Readable.from(data).pipe(bb)
    await Promise.all(await this.collect(toUpload))
  }

  async collect(iterable) {
    const result = []
    for await (const item of iterable) {
      result.push(item)
    }
  
    return result
  }

  // -------------- the below functions are BEP46 helpders, especially bothGetPut which keeps the data active in the dht ----------------

  // this function is used to keep data active in the dht
  // torrent data is passed in as an argument
  // it gets the most recent data from another user in the dht
  // then puts that most recent data back into the dht
  // if it  can not get the most recent data from another user
  // then we put the torrent data that we currently have back into the dht
  bothGetPut (data) {
    return new Promise((resolve, reject) => {
      const buffAddKey = Buffer.from(data.address, 'hex')
      const buffSigData = Buffer.from(data.sig, 'hex')
      sha1(buffAddKey, (targetID) => {
        this.webtorrent.dht.get(targetID, (getErr, getData) => {
          if (getErr) {
            console.log(getErr)
          }
          if (getData) {
            this.webtorrent.dht.put(getData, (putErr, hash, number) => {
              if (putErr) {
                reject(putErr)
              } else {
                resolve({ getData, putData: { hash: hash.toString('hex'), number } })
              }
            })
          } else if (!getData) {
            this.webtorrent.dht.put({ k: buffAddKey, v: { ih: data.infoHash, ...data.stuff }, seq: data.sequence, sig: buffSigData }, (putErr, hash, number) => {
              if (putErr) {
                reject(putErr)
              } else {
                resolve({ hash: hash.toString('hex'), number })
              }
            })
          }
        })
      })
    })
  }

  // keep the data we currently hold active by putting it back into the dht
  keepData (data) {
    return new Promise((resolve, reject) => {
      this.webtorrent.dht.put({ k: Buffer.from(data.address, 'hex'), v: { ih: data.infoHash, ...data.stuff }, seq: data.sequence, sig: Buffer.from(data.sig, 'hex') }, (error, hash, number) => {
        if (error) {
          reject(error)
        } else {
          resolve({ hash: hash.toString('hex'), number })
        }
      })
    })
  }

  // tries to get the data from another user and put that recent data back into the dht to keep the data active
  keepCurrent (address) {
    return new Promise((resolve, reject) => {
      const buffAddKey = Buffer.from(address, 'hex')

      sha1(buffAddKey, (targetID) => {
        this.webtorrent.dht.get(targetID, (getErr, getData) => {
          if (getErr) {
            reject(getErr)
          } else if (getData) {
            this.webtorrent.dht.put(getData, (putErr, hash, number) => {
              if (putErr) {
                reject(putErr)
              } else {
                resolve({ getData, putData: { hash: hash.toString('hex'), number } })
              }
            })
          } else if (!getData) {
            reject(new Error('could not find property'))
          }
        })
      })
    })
  }

  // create a keypair
  createKeypair () {
    const { publicKey, secretKey } = ed.createKeyPair(ed.createSeed())

    return { address: publicKey.toString('hex'), secret: secretKey.toString('hex') }
  }

  // extract the public key/address out of a link
  addressFromLink (link) {
    if (!link || typeof (link) !== 'string') {
      return ''
    } else if (link.startsWith('bt')) {
      try {
        const parsed = new URL(link)

        if (!parsed.hostname) {
          return ''
        } else {
          return parsed.hostname
        }
      } catch (error) {
        console.log(error)
        return ''
      }
    } else if (link.startsWith('magnet')) {
      try {
        const parsed = new URL(link)

        const xs = parsed.searchParams.get('xs')

        const isMutableLink = xs && xs.startsWith(BTPK_PREFIX)

        if (!isMutableLink) {
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
}

module.exports = Main
