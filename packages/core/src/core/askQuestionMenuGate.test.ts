/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  looksLikeEnumeratedOptionsQuestion,
  shouldEnforceAskQuestion,
  ASK_QUESTION_GATE_CAP,
} from './askQuestionMenuGate.js';

// A Russian-language transcript: a question followed by enumerated options.
const RU_TRANSCRIPT = `Какую именно стратегию кэширования выбираем?

1. In-memory — хранить данные в памяти процесса приложения
2. Redis — общий кэш для нескольких экземпляров сервиса
3. CDN — кэширование статических ответов на границе сети
4. Комбинированную — несколько уровней кэша в одной схеме

Какой вариант?`;

const EN_NUMBERED = `Which datastore fits best?

1. PostgreSQL — ACID, complex schema
2. SQLite — embedded, simple
3. ScyllaDB — high throughput

Which option?`;

const EN_BULLETED = `Do you want auth?

- Yes, add login
- No, keep it open`;

describe('looksLikeEnumeratedOptionsQuestion', () => {
  it('fires on the RU transcript (list then trailing question)', () => {
    expect(looksLikeEnumeratedOptionsQuestion(RU_TRANSCRIPT)).toBe(true);
  });

  it('fires on an EN numbered choice list', () => {
    expect(looksLikeEnumeratedOptionsQuestion(EN_NUMBERED)).toBe(true);
  });

  it('fires on a 2-item bulleted question', () => {
    expect(looksLikeEnumeratedOptionsQuestion(EN_BULLETED)).toBe(true);
  });

  it('does NOT fire without a question mark', () => {
    const noQuestion = `Here is the plan:

1. First do this
2. Then do that
3. Finally commit`;
    expect(looksLikeEnumeratedOptionsQuestion(noQuestion)).toBe(false);
  });

  it('does NOT fire on a single enumerated item with a question', () => {
    expect(looksLikeEnumeratedOptionsQuestion('Ready?\n\n1. Proceed')).toBe(
      false,
    );
  });

  it('does NOT fire when list items are long paragraphs', () => {
    const longItems = `Which approach?

1. ${'x'.repeat(130)}
2. ${'y'.repeat(130)}`;
    expect(looksLikeEnumeratedOptionsQuestion(longItems)).toBe(false);
  });

  it('fires on a many-option question (>6 items — option count is not a ceiling)', () => {
    const many = `Which?

1. a
2. b
3. c
4. d
5. e
6. f
7. g`;
    expect(looksLikeEnumeratedOptionsQuestion(many)).toBe(true);
  });

  it('fires on a bundled multi-question message (regression: bundled questions)', () => {
    // The model bundled THREE clarifying questions into one message, producing
    // 9 enumerated items — this previously fell foul of the ≤6 upper bound and
    // silently did not fire. It MUST fire.
    const bundled = `Давайте разберёмся, что именно нужно.

Что именно кэшируем?

1. Ответы API целиком — сохранять тело ответа по ключу запроса
2. Результаты запросов к БД — кэшировать выборки на уровне репозитория
3. Отрисованные страницы — хранить готовый HTML для каждого маршрута
4. Или что-то другое?

Откуда брать время жизни записей?
- Из отдельной таблицы (например, cacheRules)
- Закодировано в конфиге / аргументе командной строки
- Не нужно — записи не протухают

Формат вывода?
- Просто JSON в stdout
- Таблица в терминал
- Что-то ещё

Один вопрос за раз — начнём с первого: какой именно слой кэширования нужен?`;
    expect(looksLikeEnumeratedOptionsQuestion(bundled)).toBe(true);
  });

  it('fires when short options are mixed with one long item (long item skipped, not fatal)', () => {
    const mixed = `Which datastore?

1. PostgreSQL
2. ${'x'.repeat(130)}
3. ScyllaDB`;
    expect(looksLikeEnumeratedOptionsQuestion(mixed)).toBe(true);
  });

  it('does NOT fire on prose with a question but no list', () => {
    expect(
      looksLikeEnumeratedOptionsQuestion('What database should we use?'),
    ).toBe(false);
  });

  it('fires on an options question that uses a full-width question mark', () => {
    // A CJK options question ("选哪个数据库？") must still render as a menu —
    // the '?' detection must not be ASCII-only.
    const cjk = `选哪个数据库？\n\n1. PostgreSQL\n2. ScyllaDB`;
    expect(looksLikeEnumeratedOptionsQuestion(cjk)).toBe(true);
  });
});

describe('shouldEnforceAskQuestion', () => {
  const base = {
    enabled: true,
    brainstormingActive: true,
    interactive: true,
    underCap: true,
    lastMessage: EN_NUMBERED,
  };

  it('fires when all conditions hold and the detector matches', () => {
    expect(shouldEnforceAskQuestion(base)).toBe(true);
  });

  it('does not fire when disabled', () => {
    expect(shouldEnforceAskQuestion({ ...base, enabled: false })).toBe(false);
  });

  it('does not fire when brainstorming is inactive', () => {
    expect(
      shouldEnforceAskQuestion({ ...base, brainstormingActive: false }),
    ).toBe(false);
  });

  it('does not fire when non-interactive', () => {
    expect(shouldEnforceAskQuestion({ ...base, interactive: false })).toBe(
      false,
    );
  });

  it('does not fire when at/over the cap', () => {
    expect(shouldEnforceAskQuestion({ ...base, underCap: false })).toBe(false);
  });

  it('does not fire when the message is not an options question', () => {
    expect(
      shouldEnforceAskQuestion({ ...base, lastMessage: 'All done!' }),
    ).toBe(false);
  });

  it('exposes a cap of 2', () => {
    expect(ASK_QUESTION_GATE_CAP).toBe(2);
  });
});
