/**
 * 注意: Uploader.js 是 basic UI 和 widget 共用的模块, 依赖尽量从 vendors 传入，不要直接引入。
 *
 * @format
 */

import Axios from 'axios'
import {PDSError} from '../utils/PDSError'
import {uuid, throttleInTimes} from '../utils/LoadUtil'
import {BaseLoader} from './BaseLoader'
import {doesFileExist} from '../utils/FileUtil'
import {calc_uploaded} from '../utils/ChunkUtil'
import {isNetworkError} from '../utils/HttpUtil'
import {formatSize} from '../utils/Formatter'
import {formatCheckpoint, initCheckpoint} from '../utils/CheckpointUtil'
import {formatPercentsToFixed, calcUploadMaxConcurrency, removeItem, calcUploadHighWaterMark} from '../utils/LoadUtil'

import Debug from 'debug'
const debug = Debug('PDSJS:BaseUploader')

const INIT_MAX_CON = 5 // 初始并发
const MAX_SIZE_LIMIT = 10 * 1024 * 1024 * 1024 * 1024 // 10 TB
const MAX_CHUNK_SIZE = 100 * 1024 * 1024 // 100MB
const LIMIT_PART_NUM = 9000 // OSS分片数最多不能超过1w片，这里取值 9000

const MAX_SIZE_FOR_SHA1 = 10 * 1024 * 1024 * 1024 // 10GB
const MIN_SIZE_FOR_PRE_SHA1 = 100 * 1024 * 1024 // 100MB

console.timeLog = console.timeLog || console.timeEnd

/**
 * events:  statechange, progress, partialcomplete
 */
export class BaseUploader extends BaseLoader {
  /**
   * abstract 需要重写实现, 返回是否秒传成功
   * @return Promise<boolean>
   */
  /* istanbul ignore next */
  async prepareAndCreate() {
    throw new Error('Method not implemented.')
  }
  /* istanbul ignore next */
  async initChunks() {
    throw new Error('Method not implemented.')
  }
  /**
   * abstract 需要重写实现, 返回是否秒传成功
   * @return Promise<void>
   */
  /* istanbul ignore next */
  async upload() {
    throw new Error('Method not implemented.')
  }

  constructor(checkpoint, configs = {}, vendors = {}, context = {}) {
    super()

    // 避免警告： possible EventEmitter memory leak detected
    // if (this.setMaxListeners) this.setMaxListeners(100)

    this.vendors = vendors
    this.context = context

    // {http_client, js_sha1, js_crc64_file, util}  = vendors

    // checkpoint 参数
    const {
      // from  html5 file
      file,

      // to folder info
      new_name, // 重命名
      path_type,
      loc_id,
      loc_type,
      parent_file_key,

      drive_id,
      share_id,
      file_id,
      file_path,
      parent_file_id,
      parent_file_path,

      // 以下可选
      id,
      file_key,
      upload_id,

      part_info_list,

      state,
      message,
      //
      progress,
      speed,
      loaded,
      chunk_size, // 分片大小

      start_time,
      end_time,

      // 均速计算
      used_avg_speed,
      used_time_len,
    } = initCheckpoint(checkpoint)

    const {
      // check_name_mode: overwrite (直接覆盖，以后多版本有用), auto_rename (自动换一个随机名称), refuse (不会创建，告诉你已经存在), ignore (会创建重名的)
      check_name_mode = 'auto_rename',

      // 是否校验
      checking_crc,
      // 调优
      max_chunk_size, // 分片大小
      init_chunk_con, // 自定义指定并发数， chunk_con_auto==false 时生效
      chunk_con_auto, // 自动调整并发数策略
      high_speed_mode, // 扩大stream缓冲区

      max_size_for_sha1, // 文件大小 小于此Bytes才秒传。太大了将直接上传。
      min_size_for_pre_sha1, // 文件大小超过此Bytes才预秒传，否则直接秒传。

      custom_crc64_fun, // 自定义计算 crc64 方法
      custom_sha1_fun, // 自定义计算sha1 方法
      custom_multi_sha1_fun, //自定义计算 sha1 方法 (分part)

      // (标准模式) 是否启用分片并发上传,  托管模式默认时并发的
      parallel_upload,

      // 最大分片数：10000片
      limit_part_num,

      verbose,
      ignore_rapid,

      // functions
      state_changed,
      progress_changed,
      part_completed,
      set_high_water_mark,
      set_calc_max_con,
    } = configs

    this.parallel_upload = parallel_upload
    // console.log('constructor', this)
    // 初始化
    this.id = id || `id-${uuid().replace(/-/g, '')}`
    // this.created_at = Date.now();

    // from
    this.file = file // {name, size, path, type}

    // to
    this.new_name = new_name
    this.path_type = path_type
    this.loc_id = loc_id
    this.loc_type = loc_type
    this.parent_file_key = parent_file_key
    this.file_key = file_key

    this.drive_id = drive_id
    this.share_id = share_id
    this.file_id = file_id
    this.file_path = file_path
    this.parent_file_id = parent_file_id
    this.parent_file_path = parent_file_path

    // 调优
    this.max_chunk_size = parseInt(max_chunk_size || MAX_CHUNK_SIZE)
    this.init_chunk_con = init_chunk_con || INIT_MAX_CON
    this.chunk_con_auto = chunk_con_auto || false
    this.high_speed_mode = high_speed_mode || false

    this.max_size_for_sha1 = max_size_for_sha1 || MAX_SIZE_FOR_SHA1
    this.min_size_for_pre_sha1 = min_size_for_pre_sha1 || MIN_SIZE_FOR_PRE_SHA1

    this.custom_crc64_fun = custom_crc64_fun
    this.custom_sha1_fun = custom_sha1_fun
    this.custom_multi_sha1_fun = custom_multi_sha1_fun

    this.checking_crc = checking_crc !== false
    this.limit_part_num = limit_part_num || LIMIT_PART_NUM

    // 同名 策略
    this.check_name_mode = check_name_mode

    // funs
    this.state_changed = state_changed
    this.progress_changed = progress_changed
    this.part_completed = part_completed

    // debug
    this.set_high_water_mark = set_high_water_mark || calcUploadHighWaterMark
    this.set_calc_max_con = this.chunk_con_auto
      ? set_calc_max_con || calcUploadMaxConcurrency
      : () => {
          /* istanbul ignore next */
          return this.init_chunk_con
        }

    // progress & state
    this.state = state || 'waiting'
    this.message = message || ''
    this.progress = progress || 0
    this.speed = speed || 0
    this.loaded = loaded || 0

    this.left_time = 0

    this.start_time = start_time
    this.end_time = end_time

    this.chunk_size = chunk_size

    // 是否打印详细日志
    this.verbose = verbose != null ? verbose : true

    // 均值计算
    this.used_avg_speed = used_avg_speed || 0
    this.used_time_len = used_time_len || 0
    this.avg_speed = this.used_avg_speed

    // uploading info
    this.upload_id = upload_id

    part_info_list ? (this.part_info_list = part_info_list) : null

    this.cancelSources = []
    this.checking_progress = 0
    this.sha1_progress = 0
    // 测试专用

    this.ignore_rapid = ignore_rapid || false
  }

  async handleError(e) {
    if (this.cancelFlag) {
      await this.changeState('error', e)
      return e
    }

    if (e.message == 'stopped') {
      this.stop()
      return e
    }

    this.message = e.message
    this.end_time = Date.now()
    this.timeLogEnd('task', Date.now())

    console.warn(
      `${this.file.name} (uploadId: ${this.upload_id}, size:${this.file.size}) 上传失败, 耗时:${
        this.end_time - this.start_time
      }ms. [ERROR]: ${e.message}`,
    )
    if (this.verbose) {
      if (e.response) {
        console.error(e.stack)
      } else console.error(e.stack)
    }

    if (isNetworkError(e)) {
      this.stop()
    } else {
      // 只要error，cancel 所有请求
      this.cancelAllUploadRequests()
      this.calcTotalAvgSpeed()
      this.on_calc_crc_success = false
      this.on_calc_crc_failed = false

      // 报错，下次要重头开始
      this.upload_id = ''
      this.part_info_list = []

      await this.changeState('error', e)
      this.stopCalcSpeed()
    }
    return e
  }

  getCheckpoint() {
    let cp = {
      // progress & state
      loaded: this.loaded,
      size: this.file.size,
      progress: this.progress, // 0-100
      state: this.state,

      // 计算的均速
      used_avg_speed: this.used_avg_speed,
      // 计算的时长
      used_time_len: this.used_time_len,
      start_time: this.start_time,
      end_time: this.end_time,

      // 分片大小
      chunk_size: this.chunk_size,

      // from
      file: {
        name: this.file.name,
        size: this.file.size,
        path: this.file.path,
        type: this.file.type,
      },

      // to
      new_name: this.new_name,
      path_type: this.path_type,
      loc_id: this.loc_id,
      loc_type: this.loc_type,
      parent_file_key: this.parent_file_key,

      file_key: this.file_key,

      // uploading info
      upload_id: this.upload_id || undefined,
      part_info_list: (this.part_info_list || []).map(n => {
        return {
          part_number: n.part_number,
          part_size: n.part_size,
          etag: n.etag,
          from: n.from,
          to: n.to,
          start_time: n.start_time,
          end_time: n.end_time,
        }
      }),
    }

    return formatCheckpoint(cp)
  }

  async wait() {
    if (['waiting'].includes(this.state)) return

    this.error = null
    this.stopCalcSpeed()
    this.stopFlag = false
    this.cancelFlag = false

    if (['error'].includes(this.state)) {
      // 从头来
      delete this.upload_id
      delete this.end_time
      delete this.message
      this.initChunks()
    }

    await this.changeState('waiting')
  }
  calcTotalAvgSpeed() {
    // this.used_time_len = this.used_time_len;
    // this.used_avg_speed = this.used_avg_speed;
    const cur_time_len = Date.now() - this.upload_start_time
    const cur_loaded_size = this.loaded - (this.start_done_part_loaded || 0)

    // console.log('之前的使用时长',this.used_time_len, '之前的平均速度', this.used_avg_speed)
    // console.log('当前的使用时长',cur_time_len, '当前 loaded', cur_loaded_size)
    if (this.used_time_len && this.used_avg_speed) {
      this.avg_speed =
        (((this.used_time_len / 1000) * this.used_avg_speed + cur_loaded_size) / (this.used_time_len + cur_time_len)) *
        1000
    } else {
      this.avg_speed = (cur_loaded_size / cur_time_len) * 1000
    }
    this.used_time_len += cur_time_len
    this.used_avg_speed = this.avg_speed
  }

  doStop() {
    this.calcTotalAvgSpeed()
    this.stopCalcSpeed()

    this.stopFlag = true

    if (['stopped', 'success', 'rapid_success', 'error'].includes(this.state)) return

    this.cancelAllUploadRequests()
    this.on_calc_crc_success = false
    this.on_calc_crc_failed = false
  }
  async stop() {
    this.doStop()
    await this.changeState('stopped')
  }
  async cancel() {
    this.cancelFlag = true
    this.doStop()
    await this.changeState('cancelled')
  }

  cancelAllUploadRequests() {
    if (this.verbose) console.warn('cancel all upload request')

    if (this.cancelSources && this.cancelSources.length > 0) {
      this.cancelSources.forEach(n => {
        n.cancel('stopped')
      })
      this.cancelSources = []
    } else {
      console.log('没有可用cancel的请求')
      // this.changeState('stopped')
    }
  }

  startCalcSpeed() {
    this.left_time = 0
    this.speed = 0
    let lastLoaded = this.loaded

    // var c = 0;
    if (this.tid_speed) clearInterval(this.tid_speed)

    this.tid_speed = setInterval(() => {
      // if (c > 4 || c < 2) {
      // 进度会回退, 可能为负数，max(0, )
      this.speed = Math.max(0, this.loaded - lastLoaded) //  / 2;
      // 进度为0，left_time就会为 Infinity，改为1天
      this.left_time = this.speed === 0 ? 24 * 3600 : (this.file.size - this.loaded) / this.speed
      // console.log('速度:' + (this.speed.toFixed(2)), this.loaded, '/', this.file.size, (this.loaded / this.file.size * 100).toFixed(2) + '%')
      lastLoaded = this.loaded
      // if (c > 4) c = 2

      this.maxConcurrency = this.set_calc_max_con(this.speed, this.part_info_list[0].part_size, this.maxConcurrency)

      // check timeout
      this.checkTimeout()
      //  }
      // c++
    }, 1000)
  }

  async checkTimeout() {
    // 如果速度一直是０，则表示断网。stop
    if (this.speed_0_count == null) this.speed_0_count = 0

    if (this.speed == 0) {
      this.speed_0_count++
    } else {
      this.speed_0_count = 0
    }
    if (this.verbose && this.speed_0_count > 0) console.log(`speed==0 ${this.speed_0_count}次, 10次将重新请求`)
    if (this.speed_0_count >= 10) {
      // this.stop();
      this.speed_0_count = 0
      this.retryAllUploadRequest()
    }
  }

  /* istanbul ignore next */
  async retryAllUploadRequest() {
    this.doStop()
    // wait for 1 second
    // stop是异步的，需要等待 getStopFlagFun 都执行到。
    await new Promise(a => setTimeout(a, 1000))
    this.doStart()
  }

  stopCalcSpeed() {
    if (this.tid_speed) {
      clearInterval(this.tid_speed)
    }
    this.speed = 0
  }

  async changeState(state, error = null) {
    this.state = state

    if (['rapid_success', 'success'].includes(state)) {
      if (!this.context.isNode) {
        // 成功后释放 HTML5 File 对象，减少内存占用
        this.file = {
          name: this.file.name,
          size: this.file.size,
          path: this.file.path,
          type: this.file.type,
        }
      }
    }

    if (this.verbose) {
      console.log(`[${this.file.name}] state: ${state} ${error ? `[ERROR]${error.message}` : ''}`)
    }

    const cp = this.getCheckpoint()
    if (typeof this.state_changed === 'function') {
      await this.state_changed(cp, cp.state, error)
    }
    this.emit('statechange', cp, cp.state, error)
  }

  async start() {
    console.log('-- Uploader call start(), state=', this.state)
    // if (['success', 'rapid_success'].includes(this.status)) return
    if (!['waiting', 'error', 'stopped', 'cancelled'].includes(this.state)) return
    // 防止多次调用 start()
    this.changeState('start')
    this.doStart()
  }
  async doStart() {
    this.stopFlag = false
    this.cancelFlag = false

    try {
      // 上传流程，可以被抛出的异常阻断
      await this.run()
    } catch (e) {
      if (e.message == 'stopped' || this.stopFlag || this.cancelFlag) {
        // 忽略
        return
      }
      debug('上传文件失败:', `[${this.file.name}]`, e)
      await this.handleError(e)
    }
  }

  async run() {
    if (this.file.size > MAX_SIZE_LIMIT) {
      throw new PDSError(`File size exceeds limit: ${MAX_SIZE_LIMIT / 1024 / 1024 / 1024}GB`)
    }

    this.start_time = Date.now()

    this.timeLogStart('task', Date.now())

    // 1. 启动异步 worker, 计算 crc64
    this.startCrc64Worker()

    // 2.初始化分片信息
    if (!this.part_info_list || this.part_info_list.length === 0) {
      // 初始化分片信息
      if (this.upload_id) {
        // 之前上传过，有进度，从服务端获取进度
        const parts = await this.listAllUploadedParts()
        this.initChunks(parts)
      } else {
        this.initChunks()
      }
    }

    // 3. 获取 upload urls， 如果还没创建，先创建（创建过程包含 获取 upload urls）
    if (!this.upload_id) {
      let isRapidSuccess = await this.prepareAndCreate()
      if (isRapidSuccess) {
        this.end_time = Date.now()
        this.timeLogEnd('task', Date.now())

        this.loaded = this.file.size

        await this.changeState('rapid_success')

        if (this.verbose) {
          console.log(
            `%c${this.file.name} (size:${this.file.size}) 秒传成功,耗时:${this.end_time - this.start_time}ms`,
            'background:green;color:white;padding:2px 4px;',
          )
          this.printTimeLogs()
        }

        // 秒传成功，终止
        return
      }
    } else {
      // 获取 upload_url
      await this.getUploadUrl()
    }

    if (this.cancelFlag) {
      if (this.state != 'cancelled') await this.changeState('cancelled')
      return
    }
    // fix created 状态无法 stopped
    if (this.stopFlag) {
      if (this.state != 'stopped') await this.changeState('stopped')
      return
    }

    this.upload_start_time = Date.now()
    this.timeLogStart('upload', Date.now())

    this.startCalcSpeed()

    // 4. 分片上传
    await this.upload()

    // 5. 统计平均网速和总上传时长
    this.calcTotalAvgSpeed()

    // 6. 分片上传完成，调接口 complete
    await this.complete()

    this.timeLogEnd('upload', Date.now())

    // 7. 校验 crc64
    if (this.checking_crc) {
      try {
        await this.checkFileHash()
      } catch (e) {
        if (e.message.includes('crc64_hash not match')) {
          // 出错了，要删掉

          await this.http_client_call('deleteFile', {
            drive_id: this.loc_type == 'drive' ? this.loc_id : undefined,
            share_id: this.loc_type == 'share' ? this.loc_id : undefined,
            file_id: this.path_type == 'StandardMode' ? this.file_key : undefined,
            file_path: this.path_type == 'HostingMode' ? this.file_key : undefined,
            permanently: true,
          })
        }
        throw e
      }
    }

    this.end_time = Date.now()
    this.timeLogEnd('task', Date.now())

    // 8. 修改状态成功
    await this.changeState('success')

    if (this.verbose) {
      console.log(
        `%c${this.file.name} (size:${this.file.size}) 上传成功,耗时:${this.end_time - this.start_time}ms`,
        'background:green;color:white;padding:2px 4px;',
      )
      this.printTimeLogs()

      console.log(`avg speed: ${formatSize(this.used_avg_speed)}/s`)
    }

    return this
  }

  async startCrc64Worker() {
    this.on_calc_crc_success = false
    this.on_calc_crc_failed = false
    const workerRun = async () => {
      debug('start worker: calcFileCRC64')
      try {
        this.calc_crc64 = await this.calcFileCRC64()
        if (this.on_calc_crc_success) this.on_calc_crc_success(this.calc_crc64)
      } catch (e) {
        if (e.message == 'stopped') return
        if (this.on_calc_crc_failed) this.on_calc_crc_failed(new PDSError(e.message))
      }
    }
    this.calc_crc64 = ''
    if (this.checking_crc) {
      workerRun()
    }
  }

  async create() {
    return await this.vendors.http_util.callRetry(this.doCreate, this, [], {
      verbose: this.verbose,
      getStopFlagFun: () => {
        return this.stopFlag
      },
    })
  }
  /* istanbul ignore next */
  async getUploadUrl() {
    return await this.vendors.http_util.callRetry(this.doGetUploadUrl, this, [], {
      verbose: this.verbose,
      getStopFlagFun: () => {
        return this.stopFlag
      },
    })
  }
  /* istanbul ignore next */
  async complete() {
    return await this.vendors.http_util.callRetry(this.doComplete, this, [], {
      verbose: this.verbose,
      getStopFlagFun: () => {
        return this.stopFlag
      },
    })
  }

  async http_client_call(action, opt, options = {}) {
    const _key = Math.random().toString(36).substring(2)
    this.timeLogStart(action + '-' + _key, Date.now())
    try {
      return await this.vendors.http_client[action](opt, options)
    } catch (e) {
      console.error(action, 'ERROR:', e.response || e)
      throw e
    } finally {
      this.timeLogEnd(action + '-' + _key, Date.now())
    }
  }

  async doCreate() {
    const parallel_upload = this.parallel_upload
    const opt = {
      name: this.new_name || this.file.name,

      type: 'file', // file folder
      content_type: this.file.type || 'application/octet-stream',
      size: this.file.size,

      drive_id: this.loc_type == 'drive' ? this.loc_id : undefined,
      share_id: this.loc_type == 'share' ? this.loc_id : undefined,
      parent_file_id: this.path_type == 'StandardMode' ? this.parent_file_key : undefined,
      parent_file_path: this.path_type == 'HostingMode' ? this.parent_file_key : undefined,

      part_info_list: this.part_info_list,

      content_hash_name: this.sha1 ? 'sha1' : undefined,
      content_hash: this.sha1 || undefined,
      pre_hash: this.presha1 || undefined,
      ignoreError: !!this.presha1,
      parallel_upload,
    }

    // 同名策略
    if (this.path_type == 'StandardMode') {
      opt.check_name_mode = this.check_name_mode == 'overwrite' ? 'refuse' : this.check_name_mode
    }

    let result

    try {
      result = await this.http_client_call('createFile', opt, {ignoreError: parallel_upload})
    } catch (e) {
      if (e.code === 'InvalidParameterNotSupported.ParallelUpload' && this.parallel_upload) {
        // if (Global) {
        //   Global.shardEnabled = false
        // }
        this.parallel_upload = false
        console.error(e.message)
        return await this.doCreate()
      } else {
        throw e
      }
    }

    // 同名策略
    if (this.path_type == 'StandardMode' && result.exist) {
      // 覆盖 create
      if (this.check_name_mode == 'overwrite') {
        opt.file_id = result.file_id
        result = await this.http_client_call('createFile', opt)
      }
    }

    this.upload_id = result.upload_id
    this.file_key = result.file_id || result.file_path

    if (this.path_type == 'StandardMode') this.new_name = result.file_name
    ;(result.part_info_list || []).forEach((n, i) => {
      this.part_info_list[i].upload_url = n.upload_url
    })

    this.rapid_upload = result.rapid_upload
    await this.changeState('created')

    if (this.stopFlag) {
      throw new Error('stopped')
    }

    return result
  }
  /* istanbul ignore next */
  async doGetUploadUrl() {
    const result = await this.http_client_call('getFileUploadUrl', {
      upload_id: this.upload_id,
      drive_id: this.loc_type == 'drive' ? this.loc_id : undefined,
      share_id: this.loc_type == 'share' ? this.loc_id : undefined,
      part_info_list: this.part_info_list.map(n => {
        const checkpoint = {part_number: n.part_number}
        if (n.parallel_sha1_ctx) {
          checkpoint.parallel_sha1_ctx = n.parallel_sha1_ctx
        }
        return checkpoint
      }),
      file_id: this.path_type == 'StandardMode' ? this.file_key : undefined,
      file_path: this.path_type == 'HostingMode' ? this.file_key : undefined,
    })

    result.part_info_list.forEach((n, i) => {
      this.part_info_list[i].upload_url = n.upload_url
    })
    return result
  }

  notifyPartCompleted(partInfo) {
    const cp = this.getCheckpoint()
    let part = JSON.parse(JSON.stringify(partInfo))
    delete part.upload_url

    if (typeof this.part_completed === 'function') {
      this.part_completed(cp, part)
    }
    this.emit('partialcomplete', cp, part)
  }

  async upload_parallel() {
    await this.changeState('running')

    this.done_part_loaded = calc_uploaded(this.part_info_list)
    this.start_done_part_loaded = this.done_part_loaded // 用于计算平均速度
    this.loaded = this.done_part_loaded

    this.startCalcSpeed()

    const that = this
    let con = 0

    this.maxConcurrency = this.init_chunk_con

    const running_parts = {}

    // 缓冲修改 progress
    this.updateProgressThrottle = throttleInTimes(() => {
      this.updateProgress(running_parts)
    })

    try {
      await new Promise((resolve, reject) => {
        check_upload_next_part()

        function check_upload_next_part() {
          if (that.stopFlag) {
            reject(new Error('stopped'))
            return
          }

          let allDone = true
          let allRunning = true
          let nextPart = null
          for (const n of that.part_info_list) {
            if (!n.etag) {
              allDone = false
              if (!n.running) {
                nextPart = n
                allRunning = false
                break
              }
            }
          }

          if (allDone) {
            resolve()
            return
          }

          if (allRunning) {
            return
          }

          if (con < that.maxConcurrency) {
            if (that.verbose) console.log('并发: ', con + 1, '/', that.maxConcurrency)
            const partInfo = nextPart // that.getNextPart()

            if (!partInfo) {
              return
            }

            running_parts[partInfo.part_number] = 0
            up_part(partInfo)

            check_upload_next_part()
          }
        }

        async function up_part(partInfo) {
          if (that.stopFlag) {
            reject(new Error('stopped'))
            return
          }

          partInfo.running = true
          con++

          partInfo.start_time = Date.now()
          that.timeLogStart('part-' + partInfo.part_number, Date.now())

          if (that.verbose)
            console.log(
              `[${that.file.name}] upload part_number:`,
              partInfo.part_number,
              partInfo.from,
              '~',
              partInfo.to,
            )

          let part_progress_keep = {loaded: 0}
          try {
            const reqHeaders = {
              'Content-Type': '',
            }

            if (that.context.isNode) {
              reqHeaders['Content-Length'] = partInfo.part_size
            }

            const result = await that.uploadPartRetry(partInfo, {
              method: 'put',
              url: partInfo.upload_url,
              headers: reqHeaders,
              maxContentLength: Infinity,
              maxRedirects: 5,
              data: that.sliceFile(partInfo),
              onUploadProgress: e => {
                part_progress_keep = e

                running_parts[partInfo.part_number] = e.loaded || 0

                // 更新进度，缓冲
                that.updateProgressThrottle(running_parts)

                // let running_part_loaded = 0
                // for (var k in running_parts) running_part_loaded += running_parts[k]

                // that.loaded = that.done_part_loaded + running_part_loaded
                // that.progress = formatPercentsToFixed(that.loaded / that.file.size)

                // let cp = that.getCheckpoint()
                // if (typeof that.progress_changed == 'function') {
                //   that.progress_changed(cp)
                // }
                // that.emit('progress', cp)
              },
            })

            if (that.file.size == 0) {
              // fix size=0 的情况
              that.progress = 100
              that.notifyProgress(that.state, that.progress)
            }

            if ((part_progress_keep.loaded || 0) != partInfo.part_size) {
              console.warn('--------------------块上传失败(需重试)', part_progress_keep.loaded, partInfo.part_size)
              throw new Error('retry_upload_part')
            }

            partInfo.etag = result.headers.etag
            if (!partInfo.etag) {
              throw new Error('请确定Bucket是否配置了正确的跨域设置')
            }

            delete partInfo.running
            con--
            delete running_parts[partInfo.part_number]

            partInfo.end_time = Date.now()
            that.timeLogEnd('part-' + partInfo.part_number, Date.now())

            that.done_part_loaded += partInfo.part_size

            if (that.verbose) {
              console.log(
                `[${that.file.name}] upload part complete: ${partInfo.part_number}/${
                  that.part_info_list.length
                }, elapse:${partInfo.end_time - partInfo.start_time}ms`,
              )
            }

            that.notifyPartCompleted(partInfo)

            // check upload next part
            check_upload_next_part()
          } catch (e) {
            // console.log('------------------------------')
            if (e.message == 'stopped') {
              if (!that.stopFlag) {
                // continue
                setTimeout(check_upload_next_part, 1)
              } else {
                reject(e)
              }
              return
            }

            if (e.response) {
              if (e.response.status == 404) {
                if (e.response.data && e.response.data.indexOf('The specified upload does not exist') != -1) {
                  delete that.upload_id
                  that.part_info_list.forEach(n => {
                    delete n.etag
                    delete n.loaded
                    delete n.running
                  })
                }
              } else if (e.response.status == 504 || isNetworkError(e)) {
                // 重试, 海外连国内，可能会504
                con--
                check_upload_next_part()
                return
              }
            }

            if (that.verbose) {
              console.log(`[${that.file.name}] upload error part_number=${partInfo.part_number}:${e.message}`)
            }

            if (e.message == 'retry_upload_part') {
              // 重试
              con--
              check_upload_next_part()
            } else reject(e)
          }
        }
      })
    } catch (e) {
      // if(this.verbose) console.error(e)
      console.error(e.stack)
      throw e
    } finally {
      // 最后

      this.stopCalcSpeed()
    }
  }
  notifyProgress(state, progress) {
    // const cp = this.getCheckpoint()
    if (typeof this.progress_changed === 'function') {
      this.progress_changed(state, progress)
    }
    this.emit('progress', state, progress)
  }

  updateProgress(running_parts) {
    let running_part_loaded = 0
    for (const k in running_parts) running_part_loaded += running_parts[k]

    this.loaded = this.done_part_loaded + running_part_loaded
    this.progress = formatPercentsToFixed(this.loaded / this.file.size)

    this.notifyProgress(this.state, this.progress)
  }

  async uploadPartRetry(partInfo, opt) {
    return await this.vendors.http_util.callRetry(this.doUploadPart, this, [partInfo, opt], {
      verbose: this.verbose,
      getStopFlagFun: () => {
        return this.stopFlag
      },
    })
  }
  // async doesFileExist() {
  //   if (this.context.isNode) {
  //     return Promise.resolve(
  //       this.context.fs.existsSync(
  //         this.file.path ? null : new Error('A requested file or directory could not be found'),
  //       ),
  //     )
  //   }
  //   return await new Promise(res => {
  //     const fr = new FileReader()
  //     fr.onabort = function () {
  //       // 文件可能已经被删除
  //       if (fr.error.message.indexOf('A requested file or directory could not be found') === 0) res(fr.error)
  //       else res()
  //     }
  //     fr.onerror = fr.onabort
  //     fr.onload = function () {
  //       res()
  //     }
  //     fr.readAsArrayBuffer(this.file)
  //   })
  // }

  /* istanbul ignore next */
  async doUploadPart(partInfo, opt) {
    try {
      return await this._axiosUploadPart(opt)
    } catch (e) {
      const er = await doesFileExist(this.file, this.context)
      if (er) throw er
      if (
        e.response &&
        e.response.status == 403 &&
        e.response.data &&
        e.response.data.includes('AccessDenied') &&
        e.response.data.includes('expired')
      ) {
        // upload_url 过期，需要重新获取
        if (this.verbose) console.warn('upload_url 过期, 需要重新获取')
        await this.getUploadUrl()
        // update url
        opt.url = partInfo.upload_url
        return await this.doUploadPart(partInfo, opt)
      } else {
        // console.error(e)
        throw e
      }
    }
  }
  async _axiosUploadPart(opt) {
    const {CancelToken} = Axios
    const source = CancelToken.source()
    this.cancelSources.push(source)

    try {
      return await this.http_client_call('axiosUploadPart', {cancelToken: source.token, ...opt})
    } catch (e) {
      if (Axios.isCancel(e)) {
        throw new Error('stopped')
      } else throw e
    } finally {
      removeItem(this.cancelSources, source)
    }
  }

  /* istanbul ignore next */
  async getUploadPart(part_number) {
    // StandardMode 专用
    const result = await this.listUploadParts(part_number, 1)
    // 只返回一个
    const arr = result.uploaded_parts || []
    return arr.length === 1 ? arr[0] : null
  }
  /* istanbul ignore next */
  async listAllUploadedParts() {
    let part_number = 0
    let arr = []
    do {
      // eslint-disable-next-line no-await-in-loop
      const {next_part_number_marker, uploaded_parts = []} = await this.listUploadParts(part_number, 1000)
      part_number = next_part_number_marker
      arr = arr.concat(uploaded_parts || [])
    } while (part_number)
    return arr
  }
  /* istanbul ignore next */
  async listUploadParts(part_number, limit = 1000) {
    // StandardMode 专用
    return this.vendors.http_util.callRetry(this.doListUploadParts, this, [part_number, limit], {
      verbose: this.verbose,
      getStopFlagFun: () => {
        return this.stopFlag
      },
    })
  }
  /* istanbul ignore next */
  async doListUploadParts(part_number, limit = 1000) {
    const opt = {
      ignoreError: true,
      drive_id: this.loc_type === 'drive' ? this.loc_id : undefined,
      share_id: this.loc_type === 'share' ? this.loc_id : undefined,

      file_id: this.path_type === 'StandardMode' ? this.file_key : undefined,
      file_path: this.path_type === 'HostingMode' ? this.file_key : undefined,
      upload_id: this.upload_id,
      limit,
    }
    if (part_number > 1) {
      // part_number_marker==1, 则返回 part_number=2 的
      opt.part_number_marker = part_number - 1
    }
    const result = await this.http_client_call('listFileUploadedParts', opt)

    return result
  }

  async doComplete() {
    if (this.state == 'complete') return
    const params = {
      ignoreError: true,
      drive_id: this.loc_type == 'drive' ? this.loc_id : undefined,
      share_id: this.loc_type == 'share' ? this.loc_id : undefined,

      file_id: this.path_type == 'StandardMode' ? this.file_key : undefined,
      file_path: this.path_type == 'HostingMode' ? this.file_key : undefined,
      upload_id: this.upload_id,
      // content_type: this.file.type,

      part_info_list: this.part_info_list.map(n => {
        return {
          part_number: n.part_number,
          etag: n.etag,
        }
      }),
    }

    const result = await this.http_client_call('completeFile', params)

    this.content_hash_name = result.content_hash_name
    this.content_hash = result.content_hash
    this.crc64_hash = result.crc64_hash
    await this.changeState('complete')

    return result
  }

  async checkFileHash() {
    // if (!IS_ELECTRON) {
    //   return;
    // };

    await this.changeState('checking')

    if (!this.calc_crc64) {
      // if (!this.calc_crc64 || this.calc_crc64 === '0') {
      this.calc_crc64 = await new Promise((a, b) => {
        this.on_calc_crc_success = result => {
          a(result)
        }
        this.on_calc_crc_failed = e => {
          b(e)
        }
      })
      // wait for worker
      // var result = await this.calcFileCRC64();
    }

    if (this.calc_crc64 != this.crc64_hash) {
      throw new Error(`crc64_hash not match: ${this.calc_crc64} != ${this.crc64_hash}`)
    }
  }
  /* istanbul ignore next */
  async calcFileCRC64() {
    this.timeLogStart('crc64', Date.now())

    const timeKey = `crc64[${this.file.name}](${Math.random()}) elapse:`
    if (this.verbose) console.time(timeKey)

    let result
    if (this.context.isNode) {
      const _crc64_fun = this.custom_crc64_fun || this.vendors.file_util.js_crc64_file_node
      result = await _crc64_fun({
        file: this.file.path,
        onProgress: progress => {
          this.checking_progress = Math.round(progress) // 0-100
          if (this.state == 'checking') this.notifyProgress(this.state, this.checking_progress)
        },
        getStopFlagFun: () => {
          return this.stopFlag
        },
        context: this.context,
      })
    } else {
      const _crc64_fun = this.custom_crc64_fun || this.vendors.file_util.js_crc64_file
      // file: HTML5 File对象
      result = await _crc64_fun({
        file: this.file,
        onProgress: progress => {
          this.checking_progress = Math.round(progress) // 0-100
          if (this.state == 'checking') this.notifyProgress(this.state, this.checking_progress)
        },
        getStopFlagFun: () => {
          return this.stopFlag
        },
      })
    }

    if (this.verbose) console.timeLog(timeKey, ` result:`, result)

    this.timeLogEnd('crc64', Date.now())

    return result
  }
  sliceFile(partInfo) {
    const start = partInfo.from
    let end = partInfo.to
    if (this.context.isNode) {
      // 桌面端
      const {fs} = this.context
      end = Math.max(0, end - 1)
      return fs.createReadStream(this.file.path, {
        start,
        end,
        highWaterMark: this.high_speed_mode
          ? this.set_high_water_mark(this.file.size, partInfo, this.speed)
          : undefined,
      })
    } else {
      // 浏览器
      return this.file.slice(start, end)
    }
  }
}
// end