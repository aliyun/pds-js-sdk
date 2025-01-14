import {
  sha1 as calc_sha1,
  createSha1,
  sha256 as calc_sha256,
  createSha256,
  crc64 as calc_crc64,
  createCrc64,
} from './wasm/index-browser'
import {PDSError} from '../PDSError'
import {read_block, slice_file} from '../BrowserFileReaderUtil'

const CHUNK_SIZE = 512 * 1024 // 512KB
const PROGRESS_EMIT_STEP = 0.2 // 进度超过多少,回调onProgress

export {wasm_calc_hash, wasm_calc_file_hash, wasm_calc_file_hash_parts, wasm_calc_crc64, wasm_calc_file_crc64}

async function wasm_calc_crc64(buf, last = '0') {
  return await calc_crc64(buf, last || '0')
}
async function wasm_calc_file_crc64(file, onProgress, getStopFlag) {
  onProgress = onProgress || (prog => {})
  getStopFlag = getStopFlag || (() => false)

  let hash = await createCrc64()

  let blob = file

  let progress = 0
  let last_progress = 0
  await read_block(
    blob,
    CHUNK_SIZE,
    (buf, loaded, total) => {
      hash.update(buf)

      // 进度
      progress = (loaded * 100) / total
      if (progress - last_progress >= PROGRESS_EMIT_STEP) {
        try {
          onProgress(progress)
        } catch (e) {
          console.error(e)
        }
        last_progress = progress
      }
    },
    getStopFlag,
  )
  onProgress(100)
  return hash.end()
}

async function wasm_calc_hash(algorithm, buf) {
  return algorithm == 'sha1' ? await calc_sha1(buf) : await calc_sha256(buf)
}

async function wasm_calc_file_hash_parts(type, file, parts, onProgress, getStopFlag) {
  onProgress = onProgress || (prog => {})
  getStopFlag = getStopFlag || (() => false)

  let hash = type == 'sha1' ? await createSha1() : await createSha256()

  let total = file.size

  let loaded = 0
  let lastH = []
  let progress = 0
  let last_progress = 0

  for (let n of parts) {
    if (getStopFlag()) {
      throw new PDSError('stopped', 'stopped')
    }
    // 中间值
    n[`parallel_${type}_ctx`] = {
      h: [...lastH],
      part_offset: n.from,
    }

    await read_block(
      slice_file(file, n.from, n.to),
      CHUNK_SIZE,
      buf => {
        hash.update(buf)
        loaded += buf.length

        // 进度
        progress = (loaded * 100) / total
        if (progress - last_progress >= PROGRESS_EMIT_STEP) {
          try {
            onProgress(progress)
          } catch (e) {
            console.error(e)
          }
          last_progress = progress
        }
      },
      getStopFlag,
    )
    lastH = hash.getH()
    // console.log('--->H:', lastH)
  }

  onProgress(100)
  return {
    part_info_list: parts,
    content_hash: hash.hex().toUpperCase(),
    content_hash_name: type,
  }
}

// 使用 wasm 计算
async function wasm_calc_file_hash(type, file, preSize, onProgress, getStopFlag) {
  onProgress = onProgress || (prog => {})
  getStopFlag = getStopFlag || (() => false)

  let hash = type == 'sha1' ? await createSha1() : await createSha256()

  let blob

  if (preSize) {
    // 预秒传只需计算前1000KB
    blob = slice_file(file, 0, preSize)
  } else {
    //计算整个文件的
    blob = file
  }

  let progress = 0
  let last_progress = 0
  await read_block(
    blob,
    CHUNK_SIZE,
    (buf, loaded, total) => {
      hash.update(buf)

      // 进度
      progress = (loaded * 100) / total
      if (progress - last_progress >= PROGRESS_EMIT_STEP) {
        try {
          onProgress(progress)
        } catch (e) {
          console.error(e)
        }
        last_progress = progress
      }
    },
    getStopFlag,
  )
  onProgress(100)

  return hash.hex().toUpperCase()
}
