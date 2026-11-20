## EnotDesk Guest Pilot · Linux

Оба участника запускают одно приложение. Владелец экрана выбирает «Получить помощь», передаёт одноразовую ссылку и подтверждает доступ. Помощник выбирает «Помочь» и вставляет ссылку. В следующем сеансе участники могут поменяться ролями. Учётные записи не требуются.

Скачайте архив для Linux x64 или ARM64, проверьте SHA-256 и распакуйте его целиком. Запустите `enotdesk-guest-pilot`. Оба участника указывают HTTPS-адрес одного гостевого сервера. Ввод мышью и клавиатурой проверен на X11. Код и порядок установки отдельного сервера доступны в [руководстве](https://github.com/Flint-sega/enotdesk/blob/guest-pilot-0.6.30-2-linux/docs/GUEST-PILOT.md).

Проверка через публичный TURN прошла в обе стороны. В обратном направлении на виртуальном X11 потребовался повтор захвата после холодного перезапуска. [Журнал проверки](https://github.com/Flint-sega/enotdesk/actions/runs/44724359648)

Версия с учётными записями операторов доступна в [основном релизе](https://github.com/Flint-sega/enotdesk/releases/latest).

## English

This Linux pilot allows two people to take turns giving remote help without accounts. The person sharing their screen creates a single-use invitation, approves the helper and can end the session at any time.

Download the x64 or ARM64 archive, verify its SHA-256, extract the entire archive and run `enotdesk-guest-pilot`. Both clients use the same guest server. The [setup guide](https://github.com/Flint-sega/enotdesk/blob/guest-pilot-0.6.30-2-linux/docs/GUEST-PILOT.md) covers self-hosting. The [standard edition with operator accounts](https://github.com/Flint-sega/enotdesk/releases/latest) has its own downloads.

Public TURN, video and native input passed in both directions. The reverse session on virtual X11 required a cold restart and a capture retry. [Acceptance run](https://github.com/Flint-sega/enotdesk/actions/runs/44724359648)
