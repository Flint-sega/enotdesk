# 06 — Email-канал: IMAP → тикеты, SMTP → ответы

**Требования:** R08, R08.1
**Blocked by:** 02  **Зона:** `hub/email.mjs`, hub/app.mjs (настройки), hub/web (админ-форма), package.json (+imapflow,+nodemailer пины), client/locales, hub/test
**Волна:** 3

## Что должно заработать
Письма на support-ящик становятся тикетами (тред email-канала); ответ агента в треде уходит клиенту на почту; админ настраивает IMAP/SMTP в консоли, пароли зашифрованы и не светятся.

## Критерии приёмки
- [ ] imapflow-поллер: интервал (unref), inbound → тред по Message-ID/In-Reply-To else from+subject; дедуп
- [ ] nodemailer: ответ агента (channel=email) → письмо (In-Reply-To проставлен); ошибки доставки честные в тред
- [ ] Настройки админа: host/port/tls/user/pass IMAP+SMTP, from-адрес; пароли AES-256-GCM (ENOT_SECRET_KEY), в GET маски, не в логах (тест)
- [ ] Зависимости: imapflow+nodemailer точные пины (решение владельца)
- [ ] Тесты: маппер на фикстурах писем, поллер на фейк-IMAP (инъекция), SMTP-фейк, креды не в логах
