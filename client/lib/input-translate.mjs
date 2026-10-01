// Трансляция протокольных событий ввода (wireBrowserInput / operator-input) в
// команды хелпера enotdesk-video (ADR 0027, v0.6 fix ревью GLM-5.3): словари
// разные — протокол {type:'move'|'button'|'scroll'|'key'}, хелпер
// {cmd:'mouse'|'key'|'wheel'}. Чистая функция — тесты без DOM.

// clamp координат: хелпер клампит сам, здесь защита от NaN/мусора.
const unit = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
};

export function inputEventToCommands(ev) {
  if (!ev || typeof ev.type !== 'string') return [];
  switch (ev.type) {
    case 'move':
      return [{ cmd: 'mouse', x: unit(ev.x), y: unit(ev.y), buttons: 'move' }];
    case 'button': {
      const button = ev.button === 'right' || ev.button === 'middle' ? ev.button : 'left';
      return [{ cmd: 'mouse', x: unit(ev.x), y: unit(ev.y), buttons: ev.down ? 'down' : 'up', button }];
    }
    case 'wheel':
      return [{ cmd: 'wheel', dy: Number.isFinite(Number(ev.dy)) ? Math.trunc(Number(ev.dy)) : 0 }];
    case 'key':
      if (typeof ev.key !== 'string' || ev.key === '') return [];
      return [{ cmd: 'key', key: ev.key, down: ev.down === true }];
    default:
      return []; // неизвестное — молча не отправляем (хелпер всё равно отверг бы)
  }
}
