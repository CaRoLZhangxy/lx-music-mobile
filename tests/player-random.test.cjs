const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const compiled = new Map()
const song = id => ({ id, name: id, singer: 'test', meta: {} })
const entry = (id, listId = 'test', isTempPlay = false) => ({ musicInfo: song(id), listId, isTempPlay })

// Run the real selection and history modules; isolate native audio and UI effects.
function createPlayer(ids) {
  const list = ids.map(song)
  const state = { playedList: [], tempPlayList: [], playInfo: {}, playMusicInfo: {}, musicInfo: {} }
  const dislikeInfo = { names: new Set(), musicNames: new Set(), singerNames: new Set() }
  const setting = { 'player.togglePlayMethod': 'random' }
  let random = () => 0
  let stop = async() => {}
  const playbackRequests = []
  const mocks = {
    '@/store/player/state': state,
    '@/store/setting/state': { setting },
    '@/store/dislikeList': { state: { dislikeInfo } },
    '@/utils': {},
    '@/utils/common': { getRandom: (min, max) => Math.floor(random() * (max - min)) + min },
    '@/utils/tools': { debounceBackgroundTimer: () => musicInfo => playbackRequests.push(musicInfo.id) },
    '@/utils/message': { requestMsg: {} },
    '@/config/constant': { SPLIT_CHAR: { DISLIKE_NAME: '@', DISLIKE_NAME_ALIAS: '#' }, LIST_IDS: {} },
    '@/plugins/player': { isInitialized: () => true, setStop: () => stop() },
    'react-native-background-timer': { clearTimeout() {} },
    '@/core/player/playStatus': {},
    '@/core/music': {},
    '@/core/list': {},
    '@/core/dislikeList': {},
    '@/core/player/playInfo': {
      getList: () => list,
      setPlayListId: listId => { state.playInfo.playerListId = listId },
      setPlayMusicInfo(listId, musicInfo, isTempPlay = false) {
        state.playMusicInfo = { listId, musicInfo, isTempPlay }
        state.playInfo.playerPlayIndex = list.findIndex(m => m.id === musicInfo.id)
      },
    },
  }
  const globals = {
    lx: { isPlayedStop: false },
    app_event: { pause() {} },
    state_event: { playPlayedListChanged() {}, playTempPlayListChanged() {} },
  }
  const modules = new Map()
  function load(relativePath) {
    const filename = path.join(root, relativePath)
    if (modules.has(filename)) return modules.get(filename).exports
    if (!compiled.has(filename)) {
      compiled.set(filename, ts.transpileModule(readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
        fileName: filename,
      }).outputText)
    }
    const module = { exports: {} }
    modules.set(filename, module)
    function requireModule(id) {
      if (Object.hasOwn(mocks, id)) return mocks[id]
      const target = id.startsWith('@/')
        ? path.join('src', id.slice(2))
        : path.join(path.dirname(relativePath), id)
      const alias = `@/${target.slice(4).split(path.sep).join('/')}`
      if (Object.hasOwn(mocks, alias)) return mocks[alias]
      return load(`${target}.ts`)
    }
    vm.runInNewContext(compiled.get(filename), {
      module, exports: module.exports, require: requireModule, global: globals, Set, console,
    }, { filename })
    return module.exports
  }
  return {
    state,
    list,
    dislikeInfo,
    playbackRequests,
    utils: load('src/core/player/utils.ts'),
    player: load('src/core/player/player.ts'),
    setRandom(fn) { random = fn },
    setStop(fn) { stop = fn },
  }
}

function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

test('record the selected song before waiting for the native player', async() => {
  const { player, state, setStop } = createPlayer(['A', 'B', 'C'])
  await player.playList('test', 0)
  const stopped = deferred()
  const started = deferred()
  setStop(() => { started.resolve(); return stopped.promise })
  const next = player.playNext(true)
  await started.promise
  try {
    assert.equal(state.playMusicInfo.musicInfo.id, 'B')
    assert.deepEqual(Array.from(state.playedList, m => m.musicInfo.id), ['A', 'B'])
  } finally {
    stopped.resolve()
    await next
  }
})

test('overlapping automatic next events share one transition', async() => {
  const { player, state, setStop } = createPlayer(['A', 'B', 'C'])
  await player.playList('test', 0)
  const stopped = deferred()
  const started = deferred()
  setStop(() => { started.resolve(); return stopped.promise })
  const first = player.playNext(true)
  await started.promise
  const second = player.playNext(true)
  try {
    assert.equal(first, second)
    assert.equal(state.playMusicInfo.musicInfo.id, 'B')
  } finally {
    stopped.resolve()
    await Promise.all([first, second])
  }
  await player.playNext(true)
  assert.equal(state.playMusicInfo.musicInfo.id, 'C')
})

test('preloading that overlaps a transition cannot cache the song now playing', async() => {
  const { player, state } = createPlayer(['A', 'B', 'C', 'D'])
  await player.playList('test', 0)
  const next = player.playNext(true)
  const prefetch = player.getNextPlayMusicInfo()
  await next
  assert.equal(state.playMusicInfo.musicInfo.id, 'B')
  assert.equal(await prefetch, null)
  await player.playNext(true)
  assert.equal(state.playMusicInfo.musicInfo.id, 'C')
})

test('an old selection cannot override a song clicked while it was pending', async() => {
  const { player, state } = createPlayer(['A', 'B', 'C', 'D'])
  await player.playList('test', 0)
  const next = player.playNext(true)
  await player.playList('test', 3)
  await next
  assert.equal(state.playMusicInfo.musicInfo.id, 'D')
})

test('a superseded native stop cannot start the old song', async() => {
  const { player, setStop, playbackRequests } = createPlayer(['A', 'B', 'C', 'D'])
  await player.playList('test', 0)
  const stopped = deferred()
  const started = deferred()
  setStop(() => { started.resolve(); return stopped.promise })
  const next = player.playNext(true)
  await started.promise
  const clicked = player.playList('test', 3)
  stopped.resolve()
  await Promise.all([next, clicked])
  assert.deepEqual(playbackRequests, ['A', 'D'])
})

test('automatic next can recover after the native stop rejects', async() => {
  const { player, state, setStop } = createPlayer(['A', 'B', 'C'])
  await player.playList('test', 0)
  setStop(async() => { throw new Error('native stop failed') })
  await assert.rejects(player.playNext(true), /native stop failed/)
  setStop(async() => {})
  await player.playNext(true)
  assert.equal(state.playMusicInfo.musicInfo.id, 'C')
})

test('exclude every duplicate of a played ID without changing the list or history', () => {
  const { utils, list, dislikeInfo } = createPlayer(['A', 'B', 'C', 'C', 'C'])
  const playedList = [entry('C')]
  const { filteredList } = utils.filterMusicList({ listId: 'test', list, playedList, dislikeInfo, isNext: true })
  assert.deepEqual(Array.from(filteredList, m => m.id), ['A', 'B'])
  assert.deepEqual(list.map(m => m.id), ['A', 'B', 'C', 'C', 'C'])
  assert.deepEqual(playedList.map(m => m.musicInfo.id), ['C'])
})

test('history from other lists and temporary playback does not exclude songs', () => {
  const { utils, list, dislikeInfo } = createPlayer(['A', 'B', 'C'])
  const { filteredList } = utils.filterMusicList({
    listId: 'test', list, dislikeInfo, isNext: true,
    playedList: [entry('A', 'other'), entry('B', 'test', true), entry('C')],
  })
  assert.deepEqual(Array.from(filteredList, m => m.id), ['A', 'B'])
})

test('a completed round resets history even when the list contains duplicates', async() => {
  const { utils, state, list } = createPlayer(['A', 'B', 'C', 'C'])
  state.playedList = ['A', 'B', 'C'].map(id => entry(id))
  const { filteredList } = await utils.filterList({
    listId: 'test', list, playedList: state.playedList, playerMusicInfo: list[2], isNext: true,
  })
  assert.equal(state.playedList.length, 0)
  assert.deepEqual(Array.from(filteredList, m => m.id), ['A', 'B', 'C', 'C'])
})

for (const preload of [false, true]) {
  test(`duplicate C cannot trap playback in C → D → E (preload=${preload})`, async() => {
    const { player, state } = createPlayer(['A', 'B', 'C', 'D', 'E', 'C'])
    await player.playList('test', 0)
    const sequence = [state.playMusicInfo.musicInfo.id]
    for (let i = 0; i < 19; i++) {
      if (preload) await player.getNextPlayMusicInfo()
      await player.playNext(true)
      sequence.push(state.playMusicInfo.musicInfo.id)
    }
    assert.equal(sequence.join(''), 'ABCDE'.repeat(4))
  })

  for (const duplicate of [false, true]) {
    test(`100 random rounds cover all songs (duplicate=${duplicate}, preload=${preload})`, async() => {
      const { player, state, setRandom } = createPlayer(duplicate ? ['A', 'B', 'C', 'D', 'E', 'C'] : ['A', 'B', 'C', 'D', 'E'])
      let seed = 123
      setRandom(() => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        return seed / 4294967296
      })
      await player.playList('test', 0)
      for (let round = 0; round < 100; round++) {
        const seen = new Set()
        for (let i = 0; i < 5; i++) {
          if (round || i) {
            if (preload) await player.getNextPlayMusicInfo()
            await player.playNext(true)
          }
          seen.add(state.playMusicInfo.musicInfo.id)
        }
        assert.deepEqual([...seen].sort(), ['A', 'B', 'C', 'D', 'E'], `round ${round}`)
      }
    })
  }
}
