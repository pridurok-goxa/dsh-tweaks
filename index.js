/**
 * Хост-половина бандла dsh-tweaks: схема флагов твиков.
 *
 * Поля помечены `volatile()` — только такие DSH показывает в настройках и
 * принимает на запись, а их смена доходит до живой записи без перезапуска.
 * Значениями распоряжается браузерная половина (client.js): она читает их
 * через клиентский сервис configForms и включает нужные твики.
 *
 * `@deepseek-ai/schemastery` лежит в установке DSH, а не в нашей папке.
 * Резолвер профиля отдаёт его копию из дистрибутива плагинам, объявившим
 * пакет в peerDependencies, — отдельная установка не нужна.
 */
import Schema from '@deepseek-ai/schemastery';

/**
 * Флаги твиков: имя поля — id твика в реестре TWEAKS (client.js).
 * `default(true)` сохраняет поведение пакета до появления флагов.
 */
export const Config = Schema.object({
  zoom: Schema.boolean().default(true).volatile(),
  contextMenu: Schema.boolean().default(true).volatile(),
});

/**
 * Хост-половине регистрировать нечего: твики живут в браузере.
 * @returns {void}
 */
export function apply() {}
