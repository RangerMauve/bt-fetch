const WebTorrent = require('webtorrent')
const fs = require('fs-extra')
const path = require('path')
const sha1 = require('simple-sha1')
const ed = require('ed25519-supercop')
const derive = require('derive-key')
const bencode = require('bencode')
const busboy = require('busboy')
const { Readable } = require('stream')
const tmp = require('tmp-promise')
const crypto = require('crypto')

// const {EventIterator} = require('event-iterator')
// const EventEmitter = require('events').EventEmitter

const BTPK_PREFIX = 'urn:btpk:'
const DERIVE_NAMESPACE = 'bittorrent://'

// saves us from saving secret keys(saving secret keys even encrypted secret keys is something i want to avoid)
// with this function which was taken from the bittorrent-dht package
// we save only the signatures when we first publish a BEP46 torrent
function encodeSigData (msg) {
  const ref = { seq: msg.seq, v: msg.v }
  if (msg.salt) ref.salt = msg.salt
  return bencode.encode(ref).slice(1, -1)
}

// setting up constants
const HASH_REGEX = /^[a-fA-F0-9]{40}$/
const ADDRESS_REGEX = /^[a-fA-F0-9]{64}$/

const defOpts = {
  folder: __dirname,
  timeout: 60000
}

class TorrentManager {
  constructor (opts = {}) {
    const finalOpts = { ...defOpts, ...opts }
    this.timeout = finalOpts.timeout

    this.folder = path.resolve(finalOpts.folder)
    this.dataFolder = path.join(this.folder, 'data')
    this.metadataFolder = path.join(this.folder, 'metadata')
    this.seedKeyFile = path.join(this.folder, 'seed.key')

    fs.ensureDirSync(this.folder)
    fs.ensureDirSync(this.dataFolder)
    fs.ensureDirSync(this.metadataFolder)

    if (fs.existsSync(this.seedKeyFile)) {
      this.seedKey = fs.readFileSync(this.seedKeyFile)
    } else {
      this.seedKey = crypto.randomBytes(32)
      fs.writeFileSync(this.seedKeyFile, this.seedKey)
    }

    this.inProgressLoad = new Map()
    this.byInfohash = new Map()
    this.byPublicKey = new Map()

    this.webtorrent = new WebTorrent({ dht: { verify: ed.verify } })
    this._readyToGo = true

    // run the keepUpdated function every 1 hour, it keep the data active by putting the data back into the dht, don't run it if it is still working from the last time it ran the keepUpdated function
    // this.updateRoutine = setInterval(() => {
    //  if (this._readyToGo) {
    //    this.keepUpdated().catch(error => { console.error(error) })
    //  }
    // }, 3600000)
  }

  _trackTorrent (torrent) {
    const { infoHash, publicKey, name, files, path: torrentPath } = torrent
    const parentPath = path.join(torrentPath, name)

    files.forEach((file) => {
      file.relativePath = file.path.slice(parentPath.length).replace(/\\/, '/')
    })

    const infoHashURL = infoHash.toString('hex')
    if (this.byInfohash.has(infoHashURL)) throw new Error('Already tracking ' + infoHashURL)
    this.byInfohash.set(infoHashURL, torrent)
    torrent.on('close', () => {
      this.byInfohash.delete(infoHashURL)
    })

    if (!publicKey) return
    const publicKeyURL = publicKey.toString('hex')
    if (this.byInfohash.has(publicKeyURL)) throw new Error('Already tracking ' + publicKeyURL)
    this.byPublicKey.set(publicKeyURL, torrent)
    torrent.on('close', () => {
      this.byPublicKey.delete(publicKeyURL)
    })
  }

  async resolveTorrent (hostname) {
    if (this.inProgressLoad.has(hostname)) {
      return this.inProgressLoad.get(hostname)
    }
    const loader = this._resolveTorrent(hostname)
    this.inProgressLoad.set(hostname, loader)

    try {
      const torrent = await loader

      return torrent
    } finally {
      this.inProgressLoad.delete(hostname)
    }
  }

  async _resolveTorrent (hostname) {
    const isInfohash = hostname.length === 40 && HASH_REGEX.test(hostname)
    const isPublicKey = hostname.length === 64 && ADDRESS_REGEX.test(hostname)
    if (isInfohash) {
      if (this.byInfohash.has(hostname)) return this.byInfohash.get(hostname)
      return this.loadFromInfoHash(hostname)
    } else if (isPublicKey) {
      if (this.byPublicKey.has(hostname)) return this.byPublicKey.get(hostname)
      return this.loadFromPublicKey(hostname)
    }
  }

  async loadFromInfoHash (infoHash) {
    const torrentFile = await this.loadTorrentFile(infoHash)

    const torrentId = torrentFile || {
      infoHash,
      so: '-1'
    }

    const folderPath = path.join(this.dataFolder, infoHash)
    const torrent = await this.loadTorrent(torrentId, folderPath)

    this._trackTorrent(torrent)

    return torrent
  }

  async loadFromPublicKey (publicKey) {
    const folderPath = path.join(this.dataFolder, publicKey)
    const existingRecord = await this.loadRecord(publicKey)
    // Load latest from DHT, and load the torrent
    try {
      console.log('Resolving public key')
      let { infoHash, record, sequence } = await this.resolvePublicKey(publicKey)

      let torrentFile = null
      if (existingRecord && existingRecord?.seq >= sequence) {
        console.log('Loading existing torrent data')
        infoHash = existingRecord.v.ih.toString('hex')
        torrentFile = await this.loadTorrentFile(publicKey)
        record = existingRecord
      } else {
        await this.saveRecord(publicKey, record)
      }

      const torrentId = torrentFile || {
        infoHash,
        so: '-1'
      }

      console.log('Loading torrent')
      const torrent = await this.loadTorrent(torrentId, folderPath)

      torrent.publicKey = publicKey
      this._trackTorrent(torrent)
      await this.saveTorrentFile(torrent)
      return torrent
    } catch (e) {
      // TODO: Other messages that mean we could not resolve the address?
      if (!e.message.includes('Could not resolve address')) throw e
      console.error(e.stack)

      // If it fails, try loading record from cache
      // Use saved torrent file (underpublickey) to load the torrent
      // TODO: Check error type?
      if (!existingRecord) throw new Error('Could not resolve torrent')

      const torrentFile = await this.loadTorrentFile(publicKey)

      const torrent = await this.loadTorrent(torrentFile, folderPath)
      torrent.record = existingRecord
      torrent.publicKey = publicKey

      this._trackTorrent(torrent)

      return torrent
    }
  }

  async loadTorrent (torrentId, folderPath) {
    await fs.ensureDir(folderPath)

    const options = {
      path: folderPath,
      addUID: false
    }

    const torrent = await Promise.race([
      delayTimeout(this.timeout, new Error('Timeout: torrent took too long to load')),
      new Promise((resolve, reject) => {
        this.webtorrent.add(torrentId, options, torrent => {
          resolve(torrent)
        })
      })
    ])

    return torrent
  }

  async publishPublicKey (publicKey, secretKey, headers, data, name = 'bt-fetch torrent') {
    if (this.byPublicKey.has(publicKey)) {
      console.log('Stopping existing torrent')
      await new Promise((resolve, reject) => {
        this.byPublicKey.get(publicKey).destroy((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
    const folderPath = path.join(this.dataFolder, publicKey, name)
    await fs.ensureDir(folderPath)

    console.log('Saving torrent data to folder')
    const {
      comment,
      createdBy = 'bt-fetch',
      creationDate
    } = await this.handleFormData(folderPath, headers, data)

    // TODO: Support "info" field?
    const finalOpts = {
      name,
      comment,
      createdBy,
      creationDate,
      addUID: false
    }

    console.log('Converting folder to torrent')
    const tmpTorrent = await new Promise((resolve, reject) => {
      this.webtorrent.seed(folderPath, finalOpts, torrent => {
        resolve(torrent)
      })
    })

    tmpTorrent.publicKey = publicKey

    const { infoHash } = tmpTorrent

    await this.saveTorrentFile(tmpTorrent)

    await new Promise((resolve, reject) => {
      tmpTorrent.destroy((err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    // Try to resolve existing sequence?
    let sequence = 0
    try {
      console.log('Detecting existing sequence number')
      const record = await this.dhtGet(publicKey)
      if (record?.seq) {
        sequence = record?.seq
      }
    } catch (e) {
      // Whatever?
      console.log('Existing sequence not found')
      console.error(e)
    }

    // Generate record and publish
    console.log('Publishing to DHT')
    await this.dhtPublish(publicKey, secretKey, infoHash, sequence)

    console.log('Loading from public key')
    return this.loadFromPublicKey(publicKey)
  }

  async publishHash (headers, data, title = 'bt-fetch torrent') {
    const { path: tmpPath, cleanup } = await tmp.dir({ unsafeCleanup: true })
    try {
      await fs.ensureDir(tmpPath)

      const {
        name = title,
        comment,
        createdBy = 'bt-fetch',
        creationDate
      } = await this.handleFormData(tmpPath, headers, data)

      // TODO: Support "info" field?
      const finalOpts = {
        name,
        comment,
        createdBy,
        creationDate,
        addUID: false
      }

      const tmpTorrent = await new Promise((resolve, reject) => {
        this.webtorrent.seed(tmpPath, finalOpts, torrent => {
          resolve(torrent)
        })
      })

      const { infoHash } = tmpTorrent

      await this.saveTorrentFile(tmpTorrent)

      await new Promise((resolve, reject) => {
        tmpTorrent.destroy((err) => {
          if (err) reject(err)
          else resolve()
        })
      })

      const folderPath = path.join(this.dataFolder, infoHash, name)
      await fs.move(tmpPath, folderPath)

      return this.loadFromInfoHash(infoHash)
    } finally {
      cleanup()
    }
  }

  async dhtGet (publicKey) {
    try {
      const record = await new Promise((resolve, reject) => {
        sha1(publicKey, (targetID) => {
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
      return record
    } catch (e) {
      console.error('Could not load DHT record', e.stack)
      const record = await this.loadRecord(publicKey)
      if (record) return record
      throw e
    }
  }

  async dhtPut (data) {
    return new Promise((resolve, reject) => {
      this.webtorrent.dht.put(data, (err, hash) => {
        if (err) {
          reject(err)
        } else {
          resolve(hash.toString('hex'))
        }
      })
    })
  }

  async dhtPublish (publicKey, secretKey, infoHash, seq = 0) {
    const publicKeyBuff = Buffer.from(publicKey, 'hex')
    const secretKeyBuff = Buffer.from(secretKey, 'hex')
    const ih = Buffer.from(infoHash, 'hex')

    const v = { ih }
    const toSign = encodeSigData({ seq, v })

    const sig = ed.sign(toSign, publicKeyBuff, secretKeyBuff)
    const record = { k: publicKeyBuff, v, seq, sig }

    await this.saveRecord(publicKey, record)

    return this.dhtPut(record)
  }

  async loadRecord (publicKey) {
    const fileLocation = path.join(this.folder, 'metadata', `${publicKey}.dht_record`)
    const exists = await fs.pathExists(fileLocation)
    if (!exists) return null
    const buffer = await fs.readFile(fileLocation)
    return bencode.decode(buffer)
  }

  async saveRecord (publicKey, record) {
    const fileLocation = path.join(this.folder, 'metadata', `${publicKey}.dht_record`)
    const buffer = bencode.encode(record)
    await fs.writeFile(fileLocation, buffer)
  }

  async saveTorrentFile (torrent) {
    const { publicKey, infoHash, torrentFile } = torrent
    const hostname = publicKey || infoHash
    const fileLocation = path.join(this.folder, 'metadata', `${hostname}.torrent`)
    await fs.writeFile(fileLocation, torrentFile)
  }

  async loadTorrentFile (hostname) {
    const fileLocation = path.join(this.folder, 'metadata', `${hostname}.torrent`)

    const exists = await fs.pathExists(fileLocation)
    if (!exists) return null
    return fs.readFile(fileLocation)
  }

  // resolve public key address to an infohash
  async resolvePublicKey (publicKey) {
    const record = await this.dhtGet(publicKey)

    const { seq, v } = record
    const { ih } = v

    const infoHash = ih.toString('hex')
    const sequence = seq

    console.log({ record, infoHash })

    if (!HASH_REGEX.test(infoHash)) throw new Error('Resolved public key infoHash invalid')
    if (!Number.isInteger(sequence)) throw new Error('Resolved public key sequence number invalid')

    return {
      infoHash,
      sequence,
      record
    }
  }

  handleFormData (folderPath, headers, data) {
    const bb = busboy({ headers })
    const additionalInfo = {}

    return new Promise((resolve, reject) => {
      function handleRemoval () {
        bb.off('file', handleFiles)
        bb.off('error', handleErrors)
        bb.off('finish', handleFinish)
      }
      function handleFiles (name, file, info) {
        const { filename } = info
        const finalLocation = path.join(folderPath, filename)
        const writeStream = fs.createWriteStream(finalLocation)
        Readable.from(file).pipe(writeStream)
      }
      function handleErrors (error) {
        handleRemoval()
        reject(error)
      }
      function handleFinish () {
        handleRemoval()
        resolve(additionalInfo)
      }
      function handleField (name, val) {
        additionalInfo[name] = val
      }
      bb.on('file', handleFiles)
      bb.on('field', handleField)
      bb.once('error', handleErrors)
      bb.once('close', handleFinish)
      Readable.from(data).pipe(bb)
    })
  }

  // create a keypair
  createKeypair (petname = null) {
    let seed = null
    if (petname) {
      seed = derive(DERIVE_NAMESPACE, this.seedKey, petname)
    } else {
      seed = ed.createSeed()
    }

    const {
      publicKey,
      secretKey
    } = ed.createKeyPair(seed)

    return {
      publicKey: publicKey.toString('hex'),
      secretKey: secretKey.toString('hex')
    }
  }

  /*

OLD STUFF

TODO: Clear unneeded bits
========================================================
  */

  // keep data active in the dht, runs every hour
  async keepUpdated () {
    this._readyToGo = false
    for (const torrent of this.webtorrent.torrents) {
      if (torrent.address) {
        try {
          await this.bothGetPut(torrent)
        } catch (error) {
          console.error(error)
        }
        await new Promise((resolve, reject) => setTimeout(resolve, 5000))
      }
    }
    this._readyToGo = true
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
    if (!HASH_REGEX.test(getData.v.ih.toString('utf-8')) || !Number.isInteger(getData.seq)) {
      throw new Error('data is invalid')
    }
    for (const prop in getData.v) {
      getData.v[prop] = getData.v[prop].toString('utf-8')
    }
    const { ih, ...stuff } = getData.v
    return { magnet: `magnet:?xs=${BTPK_PREFIX}${address}`, address, infoHash: ih, sequence: getData.seq, stuff, sig: getData.sig.toString('hex'), from: getData.id.toString('hex') }
  }

  // publish an infohash under a public key address in the dht
  async publishFunc (address, secret, text) {
    for (const prop in text) {
      if (typeof (text[prop]) !== 'string') {
        throw new Error('text data must be strings')
      }
    }
    if (!HASH_REGEX.test(text.ih)) {
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
      main = JSON.parse(main.toString())
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
    main = { magnet: `magnet:?xs=${BTPK_PREFIX}${address}`, address, infoHash: ih, sequence: seq, stuff, sig: buffSig.toString('hex'), ...putData }
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
      delayTimeout(this.timeout, new Error(hash + ' took too long, it timed out'), false),
      new Promise((resolve, reject) => {
        this.webtorrent.seed(folderPath, { destroyStoreOnDestroy: true }, torrent => {
          resolve(torrent)
        })
      })
    ])
    checkTorrent.folder = folderPath
    checkTorrent.hash = hash
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
      delayTimeout(this.timeout, new Error(address + ' took too long, it timed out'), false),
      new Promise((resolve, reject) => {
        this.webtorrent.seed(folderPath, { destroyStoreOnDestroy: true }, torrent => {
          resolve(torrent)
        })
      })
    ])
    const checkProperty = await Promise.race([
      delayTimeout(this.timeout, new Error(address + ' property took too long, it timed out, please try again with only the keypair without the folder'), false),
      this.ownData(address, checkTorrent.infoHash)
    ]).catch(error => {
      this.webtorrent.remove(checkTorrent.infoHash, { destroyStore: false })
      throw error
    })
    // don't overwrite the torrent's infohash even though they will both be the same
    delete checkProperty.infoHash
    checkProperty.folder = folderPath
    for (const prop in checkProperty) {
      checkTorrent[prop] = checkProperty[prop]
    }
    return checkTorrent
  }

  // download a non-user created BEP46 torrent by their public key address, non-user meaning someone else's BEP46 torrent
  async loadAddress (address) {
    const haveTorrent = this.findTheAddress(address)
    if (haveTorrent) {
      return haveTorrent
    }
    const checkProperty = await Promise.race([
      delayTimeout(this.timeout, new Error(address + ' property took too long, it timed out'), false),
      this.resolveFunc(address)
    ])

    checkProperty.folder = path.join(this._external, checkProperty.address)

    // if current option is true, then if the infohash for the address is brand new then empty the directory and download the new infohash
    // if the current option is false, then at least make sure the main folder which is named with the public key address exists
    if (this._current) {
      if (!await fs.pathExists(checkProperty.folder + path.sep + checkProperty.infoHash)) {
        await fs.emptyDir(checkProperty.folder)
      }
    } else if (!this._current) {
      if (!await fs.pathExists(checkProperty.folder)) {
        await fs.ensureDir(checkProperty.folder)
      }
    }

    const checkTorrent = await Promise.race([
      delayTimeout(this.timeout, new Error(checkProperty.address + ' took too long, it timed out'), false),
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
    await fs.ensureDir(folderPath)
    await this.handleFormData(folderPath, headers, data)
    const checkFolderPath = await fs.readdir(folderPath, { withFileTypes: false })
    if (!checkFolderPath.length) {
      await fs.remove(folderPath)
      throw new Error('data could not be written to new torrent')
    }
    const checkTorrent = await Promise.race([
      delayTimeout(this.timeout, new Error('torrent took too long, it timed out'), false),
      new Promise((resolve, reject) => {
        this.webtorrent.seed(folderPath, { destroyStoreOnDestroy: true }, torrent => {
          resolve(torrent)
        })
      })
    ])
    const checkProperty = await Promise.race([
      delayTimeout(this.timeout, new Error(keypair.address + ' property took too long, it timed out, please try again with only the keypair without the folder'), false),
      this.publishFunc(keypair.address, keypair.secret, { ih: checkTorrent.infoHash })
    ]).catch(error => {
      this.webtorrent.remove(checkTorrent.infoHash, { destroyStore: false })
      throw error
    })
    // don't overwrite the torrent's infohash even though they will both be the same
    delete checkProperty.infoHash
    checkProperty.folder = folderPath
    for (const prop in checkProperty) {
      checkTorrent[prop] = checkProperty[prop]
    }
    return { torrent: checkTorrent, secret: keypair.secret }
  }

  // ------------- the below functions are for stopping or removing data and torrents

  // stops all torrents
  // clearData () {
  //   for (let i = 0; i < this.webtorrent.torrents.length; i++) {
  //     this.webtorrent.remove(this.webtorrent.torrents[i].infoHash, { destroyStore: false })
  //   }
  //   return 'data was stopped'
  // }

  // stops the torrent with the 40 character infohash(string)
  shredHash (hash) {
    const checkTorrent = this.findTheHash(hash)
    if (checkTorrent) {
      this.webtorrent.remove(checkTorrent.infoHash, { destroyStore: true })
      return true
    } else {
      return false
    }
  }

  shredAddress (address) {
    const checkTorrent = this.findTheAddress(address)
    if (checkTorrent) {
      this.webtorrent.remove(checkTorrent.infoHash, { destroyStore: true })
      return true
    } else {
      return false
    }
    // let result = null
    // const checkTorrent = this.findTheAddress(address)
    // if (checkTorrent) {
    //   this.webtorrent.remove(checkTorrent.infoHash, { destroyStore: true })
    //   result = true
    // } else {
    //   if(await fs.pathExists(path.join(this._external, address))){
    //     await fs.remove(path.join(this._external, address))
    //     result = true
    //   }
    //   if(await fs.pathExists(path.join(this._internal, address))){
    //     await fs.remove(path.join(this._internal, address))
    //     result = true
    //   }
    // }
    // return result
  }

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
    if (!checkTorrent) {
      throw new Error('could not find ' + hash)
    }
    const folder = checkTorrent.folder
    this.webtorrent.remove(checkTorrent.infoHash, { destroyStore: false })
    if (folder) {
      if (await fs.pathExists(folder)) {
        await fs.remove(folder)
      }
    } else {
      if (await fs.pathExists(path.join(this._external, hash))) {
        await fs.remove(path.join(this._external, hash))
      }
      if (await fs.pathExists(path.join(this._internal, hash))) {
        await fs.remove(path.join(this._internal, hash))
      }
    }
    return hash + ' was removed'
  }

  // stop the torrent with the address, then fully remove all data for the torrent, if torrent is not active, then find if we have any data on disk and if we do then delete all that data
  async removeAddress (address) {
    const checkedTorrent = this.findTheAddress(address)
    if (!checkedTorrent) {
      throw new Error('could not find ' + address)
    }
    const folder = checkedTorrent.folder
    this.webtorrent.remove(checkedTorrent.infoHash, { destroyStore: false })
    if (folder) {
      if (await fs.pathExists(folder)) {
        await fs.remove(folder)
      }
    } else {
      if (await fs.pathExists(path.join(this._external, address))) {
        await fs.remove(path.join(this._external, address))
      }
      if (await fs.pathExists(path.join(this._internal, address))) {
        await fs.remove(path.join(this._internal, address))
      }
      // if (await fs.pathExists(path.join(this._author, address))) {
      //   await fs.remove(this._author + path.sep + address)
      // }
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
            console.error(getErr)
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
}

function delayTimeout (timeout, data, shouldResolve = false) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (shouldResolve) {
        resolve(data)
      } else {
        reject(data)
      }
    }, timeout)
  })
}

module.exports = TorrentManager
