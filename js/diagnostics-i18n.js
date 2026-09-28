// Local, bundled translations: diagnostics never fetches language packs during startup.
(function (root) {
  'use strict';

  const dictionaries = {
    en: {
      diagEntry: 'Current page requests', diagEntryHint: 'Inspect request domains and routing rules',
      diagTitle: 'Page requests', diagFullTitle: 'Page diagnostics', diagBack: 'Back',
      diagFull: 'Full diagnostics', diagSettings: 'Manage rules', diagLocalOnly: 'Recorded on this device only',
      diagLoading: 'Reading records…', diagRetry: 'Retry', diagSource: 'Source page',
      diagInvalidTab: 'This page cannot be captured. Open the extension on a normal website.',
      diagCapture: 'Reload and capture', diagCapturePermission: 'Allow and capture',
      diagCaptureTitle: 'Observe first, then decide',
      diagCaptureHint: 'Observe only this tab after reloading, for up to 60 seconds. Earlier browsing history, cookies, and request bodies are not read.',
      diagCaptureActive: 'Capturing · {count} domains', diagCaptureStopped: 'Stopped · {count} domains',
      diagStop: 'Stop capture', diagClear: 'Clear records',
      diagClearConfirm: 'Clear this capture only? Permanent rules and the current trial will not change.',
      diagFilterDifferent: 'Different route', diagFilterFailed: 'Failed requests', diagFilterAll: 'All',
      diagNoMatches: 'No domains in this capture match the filter.',
      diagNoRecords: 'No requests observed yet. Return to the source page and try the action again.',
      diagCaveat: 'Different routes do not prove a fault; a response does not prove a challenge passed.',
      diagPrediction: 'Rule routes are predicted matches, not measured proxy exits.',
      diagRoute: 'Rule route', diagRouteProxy: 'Proxy first', diagRouteDirect: 'Direct',
      diagRouteSystem: 'System proxy', diagRouteUnknown: 'Unknown', diagRequest: 'Requests',
      diagFailed: '{count} failed', diagPending: '{count} unfinished', diagCompleted: '{count} completed',
      diagCount: '{count} requests', diagDetails: 'Show rule details for {host}', diagSelect: 'Select {host}',
      diagMatched: 'Matched rule', diagTypes: 'Resource types',
      diagLastStatus: 'Latest response status', diagLastError: 'Latest network error',
      diagRulesChanged: 'Rules changed. These requests were recorded before the change. Capture again to verify.',
      diagStale: 'Older records · capture again',
      diagManualConflict: 'An opposite manual rule exists. Resolve it in rule management first.',
      diagSelectHint: 'Select domains to adjust', diagSelected: '{count} domains selected',
      diagDirection: 'Trial route', diagToProxy: 'Use proxy', diagToDirect: 'Use direct',
      diagReview: 'Try selected domains', diagReviewTitle: 'Confirm this trial',
      diagReviewHint: 'Permanent rules stay unchanged. Return to the page to test the trial.',
      diagLifetime: '10 minutes · undo anytime',
      diagScope: 'Requests to these domains and their subdomains from other pages are affected too.',
      diagApply: 'Apply and reload source page', diagCancel: 'Cancel',
      diagTrialTitle: 'Trial active for {count} domains', diagTrialRemaining: 'About {count} minutes left',
      diagVerify: 'Return to page to verify', diagUndo: 'Undo trial', diagSave: 'Save permanent rules',
      diagSaveTitle: 'Save permanent rules', diagSaveHint: 'Saved rules will not revert when the trial expires.',
      diagVerified: 'I returned to the source page and confirmed these changes work.',
      diagSaveConfirm: 'Confirm save', diagTrialApplied: 'Trial applied. Return to the page to verify it.',
      diagTrialUndone: 'Trial undone. Permanent rules are unchanged.', diagTrialSaved: 'Saved as permanent rules.',
      diagModeRequired: 'Trials require Auto mode. Switch modes on the home screen first; it will not change automatically.',
      diagOtherSession: 'Capturing another page: {host}', diagReplace: 'Capture this page instead',
      diagReplaceConfirm: 'Replace the other page’s capture and reload this page?',
      diagOtherTrial: 'Another page has an active trial. Undo or save it first.',
      diagDropped: 'Record limit reached. {count} requests were not recorded.',
      diagNavigation: 'The source page changed, so capture stopped. A new capture reloads the source page.',
      diagTabClosed: 'The source tab has closed.',
      diagPermissionRevoked: 'Capture permission was removed. Please allow it again.',
      diagReadFailed: 'Background records are temporarily unavailable. Retrying will not change the page.',
      diagMutationPending: 'The background has not confirmed the result yet. Checking status; please do not submit again.',
      diagRecovery: 'Restoring the previous routing settings. New trials are temporarily unavailable; you can retry reading the state.',
      diagPermissionDenied: 'Request observation was not allowed. No capture started. You can try granting permission again.',
      diagOperationFailed: 'The operation did not complete. Please try again.',
      diagErrorPermissionRequired: 'Allow request observation before starting a capture.',
      diagErrorInvalidTab: 'Select a normal HTTP or HTTPS page.',
      diagErrorTabClosed: 'The source tab has closed. Open the extension on another page.',
      diagErrorRestrictedTab: 'Incognito and restricted pages are not supported.',
      diagErrorSessionConflict: 'Another page has a capture. Confirm replacement before starting.',
      diagErrorSessionNotFound: 'This capture has expired or was cleared. Start a new capture.',
      diagErrorTrialConflict: 'A trial is already active. Undo or save it first.',
      diagErrorTrialNotFound: 'This trial expired or was removed. Refresh the records.',
      diagErrorInvalidHosts: 'Select valid domains from this capture.',
      diagErrorInvalidDirection: 'Choose proxy or direct for the trial.',
      diagErrorRuleConflict: 'A manual rule conflicts with this change. Review your rules first.',
      diagErrorModeRequired: 'Switch to Auto mode before trying domain rules.',
      diagErrorProxyUncontrolled: 'ProxySwitch cannot control proxy settings. Check other extensions or browser policy.',
      diagErrorNoServer: 'Configure and select a proxy server first.',
      diagErrorReloadFailed: 'The source page could not be reloaded. Check the current state before trying again.',
      diagErrorStorageFailed: 'Local storage is unavailable. The operation was not confirmed.',
      diagErrorProxyFailed: 'The browser did not confirm the proxy update. Check the current state before trying again.',
      diagErrorInternalError: 'The operation failed. Refresh the records and try again.',
      diagSourceUser: 'Manual proxy rule', diagSourceWhitelist: 'Manual direct rule',
      diagSourceSubscription: 'Subscription rule', diagSourceTemporary: 'Temporary proxy rule',
      diagSourceTrial: 'Diagnostic trial', diagSourceDefault: 'Default route',
      diagSourceLocal: 'Local address', diagSourceMode: 'Current proxy mode',
      diagModeAuto: 'Auto', diagModeGlobal: 'Global proxy', diagModeDirect: 'Direct',
      diagModeSystem: 'System proxy', diagModeUnknown: 'Unknown mode'
    },
    zh_CN: {
      diagEntry: '当前页面请求', diagEntryHint: '查看请求域名与分流规则',
      diagTitle: '页面请求', diagFullTitle: '页面诊断', diagBack: '返回',
      diagFull: '完整诊断', diagSettings: '规则管理', diagLocalOnly: '仅在本机记录',
      diagLoading: '正在读取记录…', diagRetry: '重试', diagSource: '原网页',
      diagInvalidTab: '当前页面不支持采集，请在普通网页中打开扩展。',
      diagCapture: '刷新并采集', diagCapturePermission: '授权并刷新采集',
      diagCaptureTitle: '先记录，再判断',
      diagCaptureHint: '仅观察这个标签页刷新后的请求，最长 60 秒。不会读取此前浏览记录、Cookie 或请求正文。',
      diagCaptureActive: '采集中 · {count} 个域名', diagCaptureStopped: '已停止 · {count} 个域名',
      diagStop: '停止采集', diagClear: '清空记录',
      diagClearConfirm: '只清空本轮请求记录，不修改正式规则或当前试用。继续？',
      diagFilterDifferent: '分流不同', diagFilterFailed: '请求失败', diagFilterAll: '全部',
      diagNoMatches: '本轮没有符合筛选的域名。',
      diagNoRecords: '尚未观察到请求。可回到原网页重试操作。',
      diagCaveat: '分流不同不代表故障；收到响应不代表验证通过。',
      diagPrediction: '规则路由是匹配结果，不代表实测代理出口。',
      diagRoute: '规则', diagRouteProxy: '代理优先', diagRouteDirect: '直连',
      diagRouteSystem: '系统代理', diagRouteUnknown: '未知', diagRequest: '请求',
      diagFailed: '{count} 次失败', diagPending: '{count} 次未完成', diagCompleted: '{count} 次已完成',
      diagCount: '{count} 次请求', diagDetails: '查看 {host} 的规则详情', diagSelect: '选择 {host}',
      diagMatched: '匹配规则', diagTypes: '资源类型',
      diagLastStatus: '最近响应状态', diagLastError: '最近网络错误',
      diagRulesChanged: '规则已变更，下面是变更前的请求记录。请重新采集验证。',
      diagStale: '旧记录，待重新采集',
      diagManualConflict: '已有相反的手动规则，请先在规则管理中处理。',
      diagSelectHint: '请选择需要调整的域名', diagSelected: '已选 {count} 个域名',
      diagDirection: '试用线路', diagToProxy: '改为代理', diagToDirect: '改为直连',
      diagReview: '试用所选域名', diagReviewTitle: '确认本次试用',
      diagReviewHint: '暂不写入长期规则。试用期间请回网页验证效果。',
      diagLifetime: '10 分钟，可随时撤销',
      diagScope: '这些域名及其子域名在其他页面的请求也会受影响。',
      diagApply: '应用并刷新原网页', diagCancel: '取消',
      diagTrialTitle: '{count} 个域名正在试用', diagTrialRemaining: '剩余约 {count} 分钟',
      diagVerify: '回网页验证', diagUndo: '撤销试用', diagSave: '保存为长期规则',
      diagSaveTitle: '保存长期规则', diagSaveHint: '保存后不会随试用到期而恢复。',
      diagVerified: '我已回原网页验证，确认这些调整有效。',
      diagSaveConfirm: '确认保存', diagTrialApplied: '试用已应用，请回网页验证。',
      diagTrialUndone: '试用已撤销，正式规则保持不变。', diagTrialSaved: '已保存为长期规则。',
      diagModeRequired: '试用仅适用于自动模式。请先返回首页切换模式；不会自动替你切换。',
      diagOtherSession: '正在记录另一个页面：{host}', diagReplace: '改为采集当前页面',
      diagReplaceConfirm: '将清空另一页面的采集记录并刷新当前页面。继续？',
      diagOtherTrial: '另一个页面有进行中的试用，请先撤销或保存。',
      diagDropped: '达到记录上限，{count} 次请求未记录。',
      diagNavigation: '原网页已改变，采集已停止。重新采集将刷新原网页。',
      diagTabClosed: '原标签页已关闭。',
      diagPermissionRevoked: '采集权限已被移除，请重新授权。',
      diagReadFailed: '暂时无法读取后台记录，重试不会影响当前网页。',
      diagMutationPending: '后台仍未确认操作结果。正在重新读取状态，请勿重复提交。',
      diagRecovery: '正在恢复原有分流设置，请稍候。暂不接受新的试用；可重试读取状态。',
      diagPermissionDenied: '未获请求观察权限，没有开始采集。可以再次授权。',
      diagOperationFailed: '操作未完成，请重试。',
      diagErrorPermissionRequired: '请先授权请求观察权限，再开始采集。',
      diagErrorInvalidTab: '请选择普通 HTTP 或 HTTPS 网页。',
      diagErrorTabClosed: '原标签页已关闭，请在其他网页中打开扩展。',
      diagErrorRestrictedTab: '不支持无痕标签页及浏览器受限页面。',
      diagErrorSessionConflict: '另一页面已有采集记录，请先确认是否替换。',
      diagErrorSessionNotFound: '本轮记录已过期或清除，请重新采集。',
      diagErrorTrialConflict: '已有进行中的试用，请先撤销或保存。',
      diagErrorTrialNotFound: '本次试用已到期或移除，请刷新记录。',
      diagErrorInvalidHosts: '请选择本轮采集中的有效域名。',
      diagErrorInvalidDirection: '请选择代理或直连试用线路。',
      diagErrorRuleConflict: '本次调整与已有手动规则冲突，请先检查规则。',
      diagErrorModeRequired: '请先切换至自动模式，再试用域名规则。',
      diagErrorProxyUncontrolled: 'ProxySwitch 无法控制代理设置，请检查其他扩展或浏览器策略。',
      diagErrorNoServer: '请先配置并选中代理服务器。',
      diagErrorReloadFailed: '原网页未能刷新，请检查当前状态后重试。',
      diagErrorStorageFailed: '本地存储暂不可用，尚未确认操作成功。',
      diagErrorProxyFailed: '浏览器尚未确认代理更新，请检查当前状态后重试。',
      diagErrorInternalError: '操作失败，请刷新记录后重试。',
      diagSourceUser: '手动代理规则', diagSourceWhitelist: '手动直连规则',
      diagSourceSubscription: '订阅规则', diagSourceTemporary: '临时代理规则',
      diagSourceTrial: '诊断试用', diagSourceDefault: '默认线路',
      diagSourceLocal: '本地地址', diagSourceMode: '当前代理模式',
      diagModeAuto: '自动分流', diagModeGlobal: '全局代理', diagModeDirect: '直接连接',
      diagModeSystem: '系统代理', diagModeUnknown: '模式未知'
    },
    es: {
      diagEntry: 'Solicitudes de esta página', diagEntryHint: 'Ver dominios solicitados y reglas de ruta',
      diagTitle: 'Solicitudes de la página', diagFullTitle: 'Diagnóstico de página', diagBack: 'Volver',
      diagFull: 'Diagnóstico completo', diagSettings: 'Gestionar reglas', diagLocalOnly: 'Registros solo en este dispositivo',
      diagLoading: 'Leyendo registros…', diagRetry: 'Reintentar', diagSource: 'Página de origen',
      diagInvalidTab: 'No se puede capturar esta página. Abra la extensión en un sitio web normal.',
      diagCapture: 'Recargar y capturar', diagCapturePermission: 'Permitir y capturar',
      diagCaptureTitle: 'Primero observar, después decidir',
      diagCaptureHint: 'Solo se observa esta pestaña tras recargar, durante un máximo de 60 segundos. No se lee el historial anterior, las cookies ni el cuerpo de las solicitudes.',
      diagCaptureActive: 'Capturando · {count} dominios', diagCaptureStopped: 'Detenida · {count} dominios',
      diagStop: 'Detener captura', diagClear: 'Borrar registros',
      diagClearConfirm: '¿Borrar solo esta captura? Las reglas permanentes y la prueba actual no cambiarán.',
      diagFilterDifferent: 'Ruta diferente', diagFilterFailed: 'Solicitudes fallidas', diagFilterAll: 'Todos',
      diagNoMatches: 'Ningún dominio de esta captura coincide con el filtro.',
      diagNoRecords: 'Aún no se han observado solicitudes. Vuelva a la página de origen y repita la acción.',
      diagCaveat: 'Una ruta diferente no demuestra un fallo; recibir una respuesta no demuestra que se superó la verificación.',
      diagPrediction: 'Las rutas se calculan según las reglas, no midiendo la salida real del proxy.',
      diagRoute: 'Ruta prevista', diagRouteProxy: 'Proxy preferido', diagRouteDirect: 'Directa',
      diagRouteSystem: 'Proxy del sistema', diagRouteUnknown: 'Desconocida', diagRequest: 'Solicitudes',
      diagFailed: '{count} fallidas', diagPending: '{count} sin finalizar', diagCompleted: '{count} completadas',
      diagCount: '{count} solicitudes', diagDetails: 'Ver detalles de las reglas para {host}', diagSelect: 'Seleccionar {host}',
      diagMatched: 'Regla coincidente', diagTypes: 'Tipos de recurso',
      diagLastStatus: 'Último estado de respuesta', diagLastError: 'Último error de red',
      diagRulesChanged: 'Las reglas cambiaron. Estas solicitudes se registraron antes del cambio. Capture de nuevo para verificar.',
      diagStale: 'Registros anteriores · vuelva a capturar',
      diagManualConflict: 'Existe una regla manual opuesta. Resuelva primero el conflicto en la gestión de reglas.',
      diagSelectHint: 'Seleccione los dominios que desea ajustar', diagSelected: '{count} dominios seleccionados',
      diagDirection: 'Ruta de prueba', diagToProxy: 'Usar proxy', diagToDirect: 'Conexión directa',
      diagReview: 'Probar dominios seleccionados', diagReviewTitle: 'Confirmar esta prueba',
      diagReviewHint: 'Las reglas permanentes no cambian. Vuelva a la página para verificar la prueba.',
      diagLifetime: '10 minutos · puede deshacerla',
      diagScope: 'También afecta a las solicitudes de otras páginas hacia estos dominios y sus subdominios.',
      diagApply: 'Aplicar y recargar la página', diagCancel: 'Cancelar',
      diagTrialTitle: 'Prueba activa para {count} dominios', diagTrialRemaining: 'Quedan unos {count} minutos',
      diagVerify: 'Volver a la página y verificar', diagUndo: 'Deshacer prueba', diagSave: 'Guardar reglas permanentes',
      diagSaveTitle: 'Guardar reglas permanentes', diagSaveHint: 'Las reglas guardadas no se revertirán cuando venza la prueba.',
      diagVerified: 'He vuelto a la página de origen y confirmado que estos cambios funcionan.',
      diagSaveConfirm: 'Confirmar guardado', diagTrialApplied: 'Prueba aplicada. Vuelva a la página para verificarla.',
      diagTrialUndone: 'Prueba deshecha. Las reglas permanentes no han cambiado.', diagTrialSaved: 'Guardadas como reglas permanentes.',
      diagModeRequired: 'Las pruebas requieren el modo automático. Cámbielo primero en la pantalla principal; no se cambiará automáticamente.',
      diagOtherSession: 'Capturando otra página: {host}', diagReplace: 'Capturar esta página',
      diagReplaceConfirm: '¿Reemplazar la captura de la otra página y recargar esta página?',
      diagOtherTrial: 'Otra página tiene una prueba activa. Deshágala o guárdela primero.',
      diagDropped: 'Se alcanzó el límite. No se registraron {count} solicitudes.',
      diagNavigation: 'La página de origen cambió y la captura se detuvo. Una nueva captura recargará la página.',
      diagTabClosed: 'La pestaña de origen se ha cerrado.',
      diagPermissionRevoked: 'Se retiró el permiso de captura. Concédalo de nuevo.',
      diagReadFailed: 'Los registros no están disponibles temporalmente. Reintentar no cambiará la página.',
      diagMutationPending: 'Aún no se ha confirmado el resultado. Comprobando el estado; no repita la operación.',
      diagRecovery: 'Restaurando las rutas anteriores. Las nuevas pruebas no están disponibles temporalmente; puede volver a consultar el estado.',
      diagPermissionDenied: 'No se permitió observar solicitudes. No se inició la captura. Puede volver a conceder el permiso.',
      diagOperationFailed: 'La operación no se completó. Inténtelo de nuevo.',
      diagErrorPermissionRequired: 'Permita observar solicitudes antes de iniciar una captura.',
      diagErrorInvalidTab: 'Seleccione una página HTTP o HTTPS normal.',
      diagErrorTabClosed: 'La pestaña de origen se cerró. Abra la extensión en otra página.',
      diagErrorRestrictedTab: 'No se admiten páginas restringidas ni pestañas de incógnito.',
      diagErrorSessionConflict: 'Otra página tiene una captura. Confirme su sustitución antes de empezar.',
      diagErrorSessionNotFound: 'La captura venció o se borró. Inicie una nueva.',
      diagErrorTrialConflict: 'Ya hay una prueba activa. Deshágala o guárdela primero.',
      diagErrorTrialNotFound: 'La prueba venció o se eliminó. Actualice los registros.',
      diagErrorInvalidHosts: 'Seleccione dominios válidos de esta captura.',
      diagErrorInvalidDirection: 'Elija proxy o conexión directa para la prueba.',
      diagErrorRuleConflict: 'Una regla manual entra en conflicto con el cambio. Revise las reglas primero.',
      diagErrorModeRequired: 'Cambie al modo automático antes de probar reglas de dominio.',
      diagErrorProxyUncontrolled: 'ProxySwitch no puede controlar el proxy. Compruebe otras extensiones o las políticas del navegador.',
      diagErrorNoServer: 'Configure y seleccione primero un servidor proxy.',
      diagErrorReloadFailed: 'No se pudo recargar la página de origen. Compruebe el estado antes de reintentar.',
      diagErrorStorageFailed: 'El almacenamiento local no está disponible. No se confirmó la operación.',
      diagErrorProxyFailed: 'El navegador no confirmó la actualización del proxy. Compruebe el estado antes de reintentar.',
      diagErrorInternalError: 'La operación falló. Actualice los registros e inténtelo de nuevo.',
      diagSourceUser: 'Regla manual de proxy', diagSourceWhitelist: 'Regla manual directa',
      diagSourceSubscription: 'Regla de suscripción', diagSourceTemporary: 'Regla temporal de proxy',
      diagSourceTrial: 'Prueba de diagnóstico', diagSourceDefault: 'Ruta predeterminada',
      diagSourceLocal: 'Dirección local', diagSourceMode: 'Modo de proxy actual',
      diagModeAuto: 'Automático', diagModeGlobal: 'Proxy global', diagModeDirect: 'Directa',
      diagModeSystem: 'Proxy del sistema', diagModeUnknown: 'Modo desconocido'
    },
    ru: {
      diagEntry: 'Запросы текущей страницы', diagEntryHint: 'Домены запросов и правила маршрутизации',
      diagTitle: 'Запросы страницы', diagFullTitle: 'Диагностика страницы', diagBack: 'Назад',
      diagFull: 'Подробная диагностика', diagSettings: 'Управление правилами', diagLocalOnly: 'Записи только на этом устройстве',
      diagLoading: 'Чтение записей…', diagRetry: 'Повторить', diagSource: 'Исходная страница',
      diagInvalidTab: 'Запись для этой страницы недоступна. Откройте расширение на обычном сайте.',
      diagCapture: 'Обновить и записать', diagCapturePermission: 'Разрешить и записать',
      diagCaptureTitle: 'Сначала наблюдение, затем решение',
      diagCaptureHint: 'Наблюдение только за этой вкладкой после обновления, не более 60 секунд. История посещений, cookie и тела запросов не читаются.',
      diagCaptureActive: 'Идёт запись · доменов: {count}', diagCaptureStopped: 'Запись остановлена · доменов: {count}',
      diagStop: 'Остановить запись', diagClear: 'Очистить записи',
      diagClearConfirm: 'Очистить только эту запись? Постоянные правила и текущая проверка не изменятся.',
      diagFilterDifferent: 'Другой маршрут', diagFilterFailed: 'Ошибки запросов', diagFilterAll: 'Все',
      diagNoMatches: 'В этой записи нет доменов, соответствующих фильтру.',
      diagNoRecords: 'Запросов пока нет. Вернитесь на исходную страницу и повторите действие.',
      diagCaveat: 'Разные маршруты не доказывают сбой; ответ сервера не означает успешную проверку.',
      diagPrediction: 'Маршрут рассчитан по правилам, а не измерен по фактическому выходу прокси.',
      diagRoute: 'Маршрут', diagRouteProxy: 'Сначала прокси', diagRouteDirect: 'Напрямую',
      diagRouteSystem: 'Системный прокси', diagRouteUnknown: 'Неизвестно', diagRequest: 'Запросы',
      diagFailed: 'Ошибок: {count}', diagPending: 'Не завершено: {count}', diagCompleted: 'Завершено: {count}',
      diagCount: 'Запросов: {count}', diagDetails: 'Правила для {host}', diagSelect: 'Выбрать {host}',
      diagMatched: 'Совпавшее правило', diagTypes: 'Типы ресурсов',
      diagLastStatus: 'Последний статус ответа', diagLastError: 'Последняя ошибка сети',
      diagRulesChanged: 'Правила изменились. Эти запросы записаны до изменения. Повторите запись для проверки.',
      diagStale: 'Старые записи · повторите запись',
      diagManualConflict: 'Есть противоположное ручное правило. Сначала устраните конфликт в управлении правилами.',
      diagSelectHint: 'Выберите домены для изменения', diagSelected: 'Выбрано доменов: {count}',
      diagDirection: 'Пробный маршрут', diagToProxy: 'Через прокси', diagToDirect: 'Напрямую',
      diagReview: 'Проверить выбранные домены', diagReviewTitle: 'Подтвердить пробное изменение',
      diagReviewHint: 'Постоянные правила не изменятся. Вернитесь на страницу и проверьте результат.',
      diagLifetime: '10 минут · можно отменить',
      diagScope: 'Изменение также влияет на запросы других страниц к этим доменам и их поддоменам.',
      diagApply: 'Применить и обновить страницу', diagCancel: 'Отмена',
      diagTrialTitle: 'Пробные правила · доменов: {count}', diagTrialRemaining: 'Осталось примерно {count} мин.',
      diagVerify: 'Вернуться на страницу и проверить', diagUndo: 'Отменить проверку', diagSave: 'Сохранить постоянные правила',
      diagSaveTitle: 'Сохранить постоянные правила', diagSaveHint: 'Сохранённые правила не отменятся после окончания проверки.',
      diagVerified: 'Я вернулся на исходную страницу и убедился, что изменения помогают.',
      diagSaveConfirm: 'Подтвердить сохранение', diagTrialApplied: 'Пробные правила применены. Вернитесь на страницу для проверки.',
      diagTrialUndone: 'Пробные правила отменены. Постоянные правила не изменены.', diagTrialSaved: 'Сохранено как постоянные правила.',
      diagModeRequired: 'Для проверки нужен автоматический режим. Переключите его на главном экране; режим не изменится сам.',
      diagOtherSession: 'Записывается другая страница: {host}', diagReplace: 'Записывать эту страницу',
      diagReplaceConfirm: 'Заменить запись другой страницы и обновить текущую?',
      diagOtherTrial: 'Для другой страницы действует проверка. Сначала отмените или сохраните её.',
      diagDropped: 'Достигнут лимит записей. Не записано запросов: {count}.',
      diagNavigation: 'Исходная страница изменилась, запись остановлена. Новая запись обновит исходную страницу.',
      diagTabClosed: 'Исходная вкладка закрыта.',
      diagPermissionRevoked: 'Разрешение на запись отозвано. Предоставьте его снова.',
      diagReadFailed: 'Фоновые записи временно недоступны. Повтор не изменит страницу.',
      diagMutationPending: 'Результат ещё не подтверждён. Проверяем состояние; не отправляйте запрос повторно.',
      diagRecovery: 'Восстанавливаются прежние настройки маршрутизации. Новые проверки временно недоступны; можно повторить чтение состояния.',
      diagPermissionDenied: 'Наблюдение за запросами не разрешено. Запись не началась. Можно запросить разрешение снова.',
      diagOperationFailed: 'Операция не завершена. Повторите попытку.',
      diagErrorPermissionRequired: 'Разрешите наблюдение за запросами перед началом записи.',
      diagErrorInvalidTab: 'Выберите обычную страницу HTTP или HTTPS.',
      diagErrorTabClosed: 'Исходная вкладка закрыта. Откройте расширение на другой странице.',
      diagErrorRestrictedTab: 'Вкладки инкогнито и служебные страницы не поддерживаются.',
      diagErrorSessionConflict: 'У другой страницы есть запись. Подтвердите её замену.',
      diagErrorSessionNotFound: 'Запись удалена или срок её хранения истёк. Начните новую.',
      diagErrorTrialConflict: 'Проверка уже выполняется. Сначала отмените или сохраните её.',
      diagErrorTrialNotFound: 'Проверка удалена или завершилась по времени. Обновите записи.',
      diagErrorInvalidHosts: 'Выберите допустимые домены из этой записи.',
      diagErrorInvalidDirection: 'Выберите прокси или прямое подключение.',
      diagErrorRuleConflict: 'Изменение конфликтует с ручным правилом. Сначала проверьте правила.',
      diagErrorModeRequired: 'Включите автоматический режим для проверки доменных правил.',
      diagErrorProxyUncontrolled: 'ProxySwitch не может управлять прокси. Проверьте другие расширения и политики браузера.',
      diagErrorNoServer: 'Сначала настройте и выберите прокси-сервер.',
      diagErrorReloadFailed: 'Не удалось обновить исходную страницу. Проверьте состояние перед повтором.',
      diagErrorStorageFailed: 'Локальное хранилище недоступно. Операция не подтверждена.',
      diagErrorProxyFailed: 'Браузер не подтвердил обновление прокси. Проверьте состояние перед повтором.',
      diagErrorInternalError: 'Операция не удалась. Обновите записи и повторите попытку.',
      diagSourceUser: 'Ручное правило прокси', diagSourceWhitelist: 'Ручное прямое правило',
      diagSourceSubscription: 'Правило подписки', diagSourceTemporary: 'Временное правило прокси',
      diagSourceTrial: 'Пробное правило диагностики', diagSourceDefault: 'Маршрут по умолчанию',
      diagSourceLocal: 'Локальный адрес', diagSourceMode: 'Текущий режим прокси',
      diagModeAuto: 'Автоматически', diagModeGlobal: 'Глобальный прокси', diagModeDirect: 'Напрямую',
      diagModeSystem: 'Системный прокси', diagModeUnknown: 'Режим неизвестен'
    }
  };

  const listeners = new Set();
  let storageRevision = 0;
  function normalizeLanguage(value) {
    const language = String(value || 'en').replace(/-/g, '_').toLowerCase();
    if (/^zh(?:_|$)/.test(language)) return 'zh_CN';
    if (/^es(?:_|$)/.test(language)) return 'es';
    if (/^ru(?:_|$)/.test(language)) return 'ru';
    return 'en';
  }
  function browserLanguage() {
    try { return normalizeLanguage(root.chrome.i18n.getUILanguage()); }
    catch (_) { return normalizeLanguage(root.navigator && root.navigator.language); }
  }
  let language = browserLanguage();
  function updateLanguage(value) {
    const next = !value || value === 'auto' ? browserLanguage() : normalizeLanguage(value);
    if (next === language) return;
    language = next;
    listeners.forEach(function (callback) {
      try { callback(language); } catch (_) { /* One view must not block other subscribers. */ }
    });
  }
  const api = {
    ready: null,
    t: function (key, values) {
      const template = dictionaries[language][key] || dictionaries.en[key] || String(key);
      return template.replace(/\{([A-Za-z0-9_]+)\}/g, function (match, name) {
        return values && Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match;
      });
    },
    subscribe: function (callback) {
      if (typeof callback !== 'function') return function () {};
      listeners.add(callback);
      return function () { listeners.delete(callback); };
    },
    getLanguage: function () { return language; }
  };
  try {
    root.chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !Object.prototype.hasOwnProperty.call(changes, 'appLanguage')) return;
      storageRevision += 1;
      updateLanguage(changes.appLanguage.newValue);
    });
  } catch (_) { /* Standalone diagnostics previews can run without Chrome storage. */ }
  api.ready = new Promise(function (resolve) {
    let resolved = false;
    const revision = storageRevision;
    const finish = function () {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      resolve(api);
    };
    const timeout = setTimeout(finish, 1000);
    try {
      root.chrome.storage.local.get(['appLanguage'], function (items) {
        const error = root.chrome.runtime && root.chrome.runtime.lastError;
        if (!error && revision === storageRevision) updateLanguage(items && items.appLanguage);
        finish();
      });
    } catch (_) { finish(); }
  });

  root.ProxySwitchDiagnosticsI18n = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = { api, dictionaries, normalizeLanguage };
})(typeof globalThis !== 'undefined' ? globalThis : this);
