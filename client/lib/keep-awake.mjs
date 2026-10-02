// Keep-awake на время сеанса помощи (клиент): система и дисплей не засыпают,
// пока оператор подключён или клиент ждёт помощь. Без этого ночная машина с
// Modern Standby гасит дисплей и блокирует synthetic input (приёмка v0.6.0,
// ночь 01–02.10: тёмный экран у оператора, SendInput «успешен», курсор стоит).
// Windows: SetThreadExecutionState через koffi лениво; нет koffi/не Windows —
// no-op без ошибок (на macOS/Linux сеанс держится иначе).

const ES_CONTINUOUS = 0x80000000;
const ES_SYSTEM_REQUIRED = 0x1;
const ES_DISPLAY_REQUIRED = 0x2;

export function createKeepAwake({ koffi = null, platform = process.platform } = {}) {
  let setState = null; // fn(flags:number) → number | null, ленивая инициализация
  let active = false;

  function load() {
    if (setState !== null) return setState;
    try {
      if (platform !== 'win32' || !koffi) {
        setState = () => null;
        return setState;
      }
      const lib = koffi.load('kernel32.dll');
      const fn = lib.func('uint32_t SetThreadExecutionState(uint32_t esFlags)');
      setState = (flags) => fn(flags);
    } catch {
      setState = () => null; // нет kernel32/koffi — честный no-op
    }
    return setState;
  }

  return {
    acquire() {
      if (active) return;
      active = true;
      load()(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED);
    },
    release() {
      if (!active) return;
      active = false;
      load()(ES_CONTINUOUS);
    },
    isOn() {
      return active;
    },
  };
}
