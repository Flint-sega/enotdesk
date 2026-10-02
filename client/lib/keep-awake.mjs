// Keep-awake на время сеанса помощи (клиент): система и дисплей не засыпают,
// пока оператор подключён или клиент ждёт помощь. Без этого ночная машина с
// Modern Standby гасит дисплей и блокирует synthetic input (приёмка v0.6.0,
// ночь 01–02.10: тёмный экран у оператора, SendInput «успешен», курсор стоит).
// Windows: SetThreadExecutionState через koffi лениво; нет koffi/не Windows —
// no-op без ошибок (на macOS/Linux сеанс держится иначе).
// ВАЖНО: ES_DISPLAY_REQUIRED только удерживает бодрствующий дисплей — уже
// спящий не будит. Поэтому acquire() сначала будит панель явным
// SC_MONITORPOWER(-1) broadcast (работает из интерактивного процесса юзера).

const ES_CONTINUOUS = 0x80000000;
const ES_SYSTEM_REQUIRED = 0x1;
const ES_DISPLAY_REQUIRED = 0x2;
const HWND_BROADCAST = 0xffff;
const WM_SYSCOMMAND = 0x0112;
const SC_MONITORPOWER = 0xf170; // lParam: -1 включить, 1/-2 выключить
const SMTO_ABORTIFHUNG = 0x0002;

export function createKeepAwake({ koffi = null, platform = process.platform } = {}) {
  let setState = null; // fn(flags:number) → number | null, ленивая инициализация
  let wake = null; // fn() → bool
  let active = false;

  function load() {
    if (setState !== null) return setState;
    try {
      if (platform !== 'win32' || !koffi) {
        setState = () => null;
        wake = () => false;
        return setState;
      }
      const lib = koffi.load('kernel32.dll');
      const fn = lib.func('uint32_t SetThreadExecutionState(uint32_t esFlags)');
      setState = (flags) => fn(flags);
      const user32 = koffi.load('user32.dll');
      const msg = user32.func('intptr_t __stdcall SendMessageTimeoutW(intptr_t hwnd, uint32_t msg, uintptr_t wparam, intptr_t lparam, uint32_t flags, uint32_t timeout, void *result)');
      wake = () => {
        const r = msg(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, -1, SMTO_ABORTIFHUNG, 2000, null);
        return Number(r) !== 0;
      };
    } catch {
      setState = () => null; // нет kernel32/koffi — честный no-op
      wake = () => false;
    }
    return setState;
  }

  return {
    acquire() {
      if (!active) {
        active = true;
        load();
        wake?.(); // уже спящую панель ES не включает — будим явным включением
        setState?.(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED);
      }
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
