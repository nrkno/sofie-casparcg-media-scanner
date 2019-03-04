let { ProcessLimiter } = require('../src/processLimiter')

describe('ProcessLimiter', () => {
  test('runs only one command at a time', () => {
    let firstIsFirst = false

    ProcessLimiter('a', 'ping', ['127.0.0.1', '-n', '2'],
      () => { },
      () => { })
      .then(() => {
        firstIsFirst = true
      })
      .catch(err => {
        //  console.error(err, err.stack)
        fail(err)
      })

    return ProcessLimiter('a', 'ping', ['127.0.0.1', '-n', '1'],
      () => { },
      () => { })
      .then(() => {
        expect(firstIsFirst).toBeTruthy()
      })
  })
  test('different names run simultaneously', () => {
    let firstIsFirst = false

    ProcessLimiter('a', 'ping', ['127.0.0.1', '-n', '2'],
      () => { },
      () => { })
      .then(() => {
        firstIsFirst = true
      })
      .catch(err => {
        fail(err)
      })

    return ProcessLimiter('b', 'ping', ['127.0.0.1', '-n', '1'],
      () => { },
      () => { })
      .then(() => {
        expect(firstIsFirst).toBeFalsy()
      })
  })
  test('will run one task immediately when other task is done', () => {
    return ProcessLimiter('a', 'ping', ['127.0.0.1', '-n', '2'],
      () => { },
      () => { })
      .then(() => {
        let startTime = new Date()
        return ProcessLimiter('b', 'ping', ['127.0.0.1', '-n', '1'],
          () => { },
          () => { })
          .then(() => {
            expect(startTime - new Date()).toBeLessThan(100)
          })
      })
      .catch(err => {
        fail(err)
      })
  })
  test('Multiple tasks with multiple names all run', () => {
    let promiseList = []
    promiseList.push(ProcessLimiter('a', 'ping', ['127.0.0.1', '-n', '2'],
      () => { },
      () => { })
    )
    promiseList.push(ProcessLimiter('b', 'ping', ['127.0.0.1', '-n', '2'],
      () => { },
      () => { })
    )
    promiseList.push(ProcessLimiter('c', 'ping', ['127.0.0.1', '-n', '2'],
      () => { },
      () => { })
    )
    promiseList.push(ProcessLimiter('d', 'ping', ['127.0.0.1', '-n', '2'],
      () => { },
      () => { })
    )
    promiseList.push(ProcessLimiter('d', 'ping', ['127.0.0.1', '-n', '1'],
      () => { },
      () => { })
    )
    promiseList.push(ProcessLimiter('d', 'ping', ['127.0.0.1', '-n', '1'],
      () => { },
      () => { })
    )
    promiseList.push(ProcessLimiter('d', 'ping', ['127.0.0.1', '-n', '1'],
      () => { },
      () => { })
    )
    promiseList.push(ProcessLimiter('d', 'ping', ['127.0.0.1', '-n', '1'],
      () => { },
      () => { })
    )
    promiseList.push(ProcessLimiter('d', 'ping', ['127.0.0.1', '-n', '1'],
      () => { },
      () => { })
    )

    return Promise.all(promiseList)
      .catch(err => {
        fail(err)
      })
  })
  test('crashing command returns promise rejection', () => {
    return expect(ProcessLimiter('a', 'nonexisting', ['command'],
      () => { },
      () => { })
    ).rejects.toBeTruthy()
  })
})
