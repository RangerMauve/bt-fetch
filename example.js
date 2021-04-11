const tmp = require('tmp')

tmp.setGracefulCleanup()

const makeBTFetch = require('./')

const storageLocation = tmp.dirSync({ prefix: 'btfetch_example' }).name

const fetch = makeBTFetch({
  storageLocation
})

// InfoHash for the Sintel torrent
// Taken from https://webtorrent.io/docs
// Note how the torrent contains a Sintel folder at the root.
const url = 'bt://08ada5a7a6183aae1e09d831df6748d566095a10/Sintel/'

run()

async function run () {
  console.log('Fetching torrent file list')
  console.log(url)

  const res = await fetch(url)

  console.log(res.status, res.statusText)

  console.log('Files:', await res.json())

  const resHTML = await fetch(url, {
    headers: {
      Accept: 'text/html'
    }
  })

  console.log('As HTML', await resHTML.text())

  const srtURL = url + 'Sintel.en.srt'

  console.log('Fetching subtitle track metadata')
  console.log(srtURL)

  const resHead = await fetch(srtURL, { method: 'head' })

  const { headers, status } = resHead

  console.log({ headers, status })

  console.log('Getting contents of srt file')

  const resSRT = await fetch(srtURL)

  for await (const chunk of resSRT.body) {
    console.log('Chunk:', chunk)
  }

  await fetch.destroy()
}
