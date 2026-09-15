const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const compiled = new Map()
const song = id => ({ id, name: id, singer: 'test', meta: {} })
const entry = id => ({ musicInfo: song(id), listId: 'test', isTempPlay: false })

// Run the real selection and history modules; isolate native audio and UI effects.
function createPlayer(ids) {
  const list = ids.map(song)
  const state = { playedList: [], tempPlayList: [], playInfo: {}, playMusicInfo: {}, musicInfo: {} }
  const dislikeInfo = { names: new Set(), musicNames: new Set(), singerNames: new Set() }
  const setting = { 'player.togglePlayMethod': 'random' }
  let random = () => 0
  let stop = async() => {}
  const mocks = {
    '@/store/player/state': state,
    '@/store/setting/state': { setting },
    '@/store/dislikeList': { state: { dislikeInfo } },
    '@/utils': {},
    '@/utils/tools': { debounceBackgroundTimer: () => () => {} },
    '@/utils/common': { getRandom: (min, max) => Math.floor(random() * (max - min)) + min },
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
    setting,
    list,
    dislikeInfo,
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

for (const preview of [false, true]) {
  const cases = [
    { name: 'missing current song skips history and excludes itself', ids: ['A', 'B', 'C', 'D'], current: 1, history: ['A'], expected: 'C' },
    { name: 'found current song follows the next history entry', ids: ['A', 'B', 'C', 'D'], current: 1, history: ['A', 'B', 'C'], expected: 'C' },
    { name: 'history tail resumes random selection', ids: ['A', 'B', 'C'], current: 1, history: ['A', 'B'], expected: 'C' },
    { name: 'empty history excludes the current song when alternatives exist', ids: ['A', 'B', 'C'], current: 0, history: [], expected: 'B' },
    { name: 'only available candidate remains playable', ids: ['A'], current: 0, history: [], expected: 'A' },
    { name: 'deleted history entry does not skip the next valid entry', ids: ['A', 'C', 'D'], current: 0, history: ['A', 'B', 'C', 'D'], expected: 'C' },
    { name: 'a new round excludes the current song when alternatives exist', ids: ['A', 'B'], current: 0, history: ['B', 'A'], expected: 'B' },
  ]
  for (const scenario of cases) {
    test(`${scenario.name} (preview=${preview})`, async() => {
      const { player, state } = createPlayer(scenario.ids)
      await player.playList('test', scenario.current)
      state.playedList = scenario.history.map(entry)
      if (preview) {
        const next = await player.getNextPlayMusicInfo()
        assert.equal(next.musicInfo.id, scenario.expected)
      }
      await player.playNext(true)
      assert.equal(state.playMusicInfo.musicInfo.id, scenario.expected)
    })
  }

  test(`missing current song does not reset unrelated history (preview=${preview})`, async() => {
    const { player, state } = createPlayer(['A', 'B', 'C'])
    await player.playList('test', 1)
    state.playedList = [entry('A')]
    if (preview) {
      await player.getNextPlayMusicInfo()
      assert.deepEqual(Array.from(state.playedList, m => m.musicInfo.id), ['A'])
    }
    await player.playNext(true)
    assert.deepEqual(Array.from(state.playedList, m => m.musicInfo.id), ['A', 'C'])
  })

  test(`temporary playback resumes from the original song's history position (preview=${preview})`, async() => {
    const { player, state } = createPlayer(['A', 'B', 'C'])
    await player.playList('test', 1)
    state.playedList = ['A', 'B', 'C'].map(entry)
    state.playMusicInfo = { musicInfo: song('X'), listId: 'other', isTempPlay: true }
    if (preview) assert.equal((await player.getNextPlayMusicInfo()).musicInfo.id, 'C')
    await player.playNext(true)
    assert.equal(state.playMusicInfo.musicInfo.id, 'C')
  })
}

test('single-loop playback is not affected by random candidate filtering', async() => {
  const { player, state, setting } = createPlayer(['A', 'B'])
  setting['player.togglePlayMethod'] = 'singleLoop'
  await player.playList('test', 0)
  assert.equal((await player.getNextPlayMusicInfo()).musicInfo.id, 'A')
  await player.playNext(true)
  assert.equal(state.playMusicInfo.musicInfo.id, 'A')
})


test('a second next request does not jump to the first history entry while native stop is pending', async() => {
  const { player, state, setStop } = createPlayer(['A', 'B', 'C'])
  await player.playList('test', 0)
  const stopped = deferred()
  const started = deferred()
  setStop(() => { started.resolve(); return stopped.promise })
  const first = player.playNext(true)
  await started.promise
  // Reproduce the missing-history state without moving history updates earlier.
  const historyBeforeSecond = Array.from(state.playedList, m => m.musicInfo.id)
  const secondStarted = deferred()
  setStop(() => { secondStarted.resolve(); return stopped.promise })
  const second = player.playNext(true)
  await secondStarted.promise
  stopped.resolve()
  await Promise.all([first, second])
  assert.deepEqual(historyBeforeSecond, ['A'])
  assert.equal(state.playMusicInfo.musicInfo.id, 'C')
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

for (const preload of [false, true]) {
  test(`100 random rounds cover all songs (preload=${preload})`, async() => {
    const { player, state, setRandom } = createPlayer(['A', 'B', 'C', 'D', 'E'])
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
