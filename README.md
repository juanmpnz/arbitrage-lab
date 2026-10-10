# Arbitrage Lab

Monitor de investigación de arbitraje triangular Spot con datos públicos de Binance. Incluye un escáner Python de terminal y un panel React con cotizaciones WebSocket. Permite consultar una cuenta Binance mediante un backend local y ejecutar ciclos Spot manuales con presupuesto acotado cuando se habilita expresamente el módulo de trading. Está desactivado por defecto.

## Panel React

Requisitos: Node.js 22.12+ para panel y backend.

```bash
npm install
npm run dev
```

El navegador consulta `exchangeInfo` y `ticker/24hr` para elegir hasta 900 pares Spot activos por volumen aproximado en USD. Luego se suscribe a sus streams individuales `<symbol>@bookTicker` por WebSocket, usando TLS por el puerto 443 y lotes de 100 pares con pausa entre solicitudes. Binance publica estos streams Spot por `:443` o `:9443`; se usa 443 para redes que bloquean puertos TLS no estándar. Los precios se mantienen localmente; no se guardan claves ni se envía información privada. Las respuestas de suscripción con error se muestran en el panel.

```bash
npm run build
npm run preview
npm run test:engine
```

El monitor muestra solo rutas cuyas tres cotizaciones tengan menos de dos segundos de antigüedad al calcular. Para cada pata usa el ask al comprar y el bid al vender, descuenta la comisión y el deslizamiento configurados, y limita el tamaño por la cantidad publicada en el mejor precio. Las señales se calculan con un importe virtual; el paper trader opcional mantiene una cuenta separada.

### Paper trading

El panel incluye un simulador de cuenta virtual con saldo inicial de 1.000 USDT. Está pausado al abrir la página y solo ejecuta simulaciones mientras el usuario lo activa y el stream está en directo. Cuando una ruta positiva supera los parámetros actuales, registra una operación y suma su resultado neto estimado al saldo. La misma ruta tiene una pausa de 60 segundos para evitar contar la misma señal continuamente. Saldo e historial se conservan en el almacenamiento local del navegador; no se envían a Binance.

Este primer simulador modela una conversión completa e instantánea con las cotizaciones `bookTicker`, que muestran solo el primer nivel del libro. No modela profundidad adicional, ejecuciones parciales, cambios de precio durante las patas ni fallos intermedios. Por eso es una prueba de flujo y una estimación, no una validación de rentabilidad ejecutable. Si las comisiones o el deslizamiento están configurados en cero, el saldo acumulado también los omite.

Si el navegador bloquea la conexión a Binance por red, país o CORS, el panel lo indicará. No hay proxy para sortear bloqueos. El WebSocket del navegador responde automáticamente a los controles de protocolo y se rota antes del límite de 24 horas; al cerrarse, intenta reconectar con espera creciente.

## Conectar cuenta Binance (solo lectura)

Se necesita Node.js 22.12+ para el backend. En la raíz del repo:

```bash
cp .env.example .env
```

Completa `BINANCE_API_KEY` y `BINANCE_API_SECRET` en `.env` con una clave HMAC de Binance que tenga permiso de lectura. Mantén trading y retiros desactivados y restringe la clave a la IP pública desde la que se conectará el backend. `BINANCE_TESTNET=false` consulta tu cuenta Spot real; para Testnet usa `true` y claves exclusivas de ese entorno. Las claves y archivos `.env` están excluidos de Git; nunca uses el prefijo `VITE_` para secretos.

En dos terminales, desde la raíz:

```bash
npm run dev:api
```

```bash
npm run dev
```

Pulsa **Conectar cuenta** en el panel. Las consultas se realizan a través del proxy de Vite hacia el backend local (127.0.0.1:8787). Muestra saldos Spot disponibles/bloqueados y permite consultar comisiones de un símbolo. Las comisiones reales se presentan por componentes: no se aplican automáticamente al escáner, ni el saldo real modifica la cuenta virtual. Reinicia el backend después de editar `.env`. Si cambias `API_PORT`, cambia también el puerto del proxy en `vite.config.ts`.

La API de Binance admite consultas GET mediante `/api/health`, `/api/account`, `/api/markets`, `/api/reference-price` y `/api/commission?symbol=BTCUSDT`; además admite POST para historial local y ejecución manual configurada; no contiene endpoints de retiros. Firma HMAC en el servidor, sincroniza el reloj con Binance, limita el tiempo de espera y reutiliza respuestas por 15 s (saldo) o 60 s (comisiones). El backend escucha únicamente en loopback y rechaza hosts/orígenes externos. Esta configuración es para uso local; no publiques este servicio privado en internet.

```bash
npm run test:api
```

## Escáner Python

Requisitos: Python 3.11+; solo biblioteca estándar.

```bash
python3 bot.py --mode demo
python3 -m unittest discover -s tests -v
python3 bot.py --mode live
python3 bot.py --mode live --cycles 0 --interval 10
```

El modo demo usa precios inventados y marca la salida como sintética. El modo live usa REST, por lo que sirve para comprobar el motor y la conectividad, no para arbitraje de baja latencia. Los registros locales se guardan en `observations.sqlite`.

## Límites del cálculo

- El panel escucha solo 900 mercados, un conjunto que cubre activos puente comunes y se ordena por volumen convertido aproximadamente a USD. No cubre todos los pares de Binance.
- `bookTicker` informa únicamente la mejor oferta y demanda; la liquidez visible se limita a ese nivel. No modela profundidad completa, filtros de lote, redondeos, importe mínimo, fills parciales ni saldo residual.
- La edad medida es el tiempo desde que el navegador recibió cada mensaje; no equivale a una prueba de que las tres cotizaciones sean simultáneas ni ejecutables.
- Las tasas por defecto son supuestos configurables: 10 puntos base de comisión y 5 de deslizamiento por pata. Comprueba tus costes reales.
- Ver una señal no demuestra una ganancia realizable. No se extrapolan beneficios.
- La conexión Spot WebSocket puede cerrarse durante mantenimientos, al llegar a 24 horas o por límites de Binance. El cliente reconecta; no intenta evadir bloqueos.

## Verificación

- Build React/TypeScript/Vite aprobado.
- 41 pruebas Node: motor/WebSocket, backend firmado, filtros/tarifas, historial persistente y ejecución simulada.
- Ejecutor verificado con un exchange simulado: tres tramos completos, presupuesto duradero, exclusión entre procesos, tokens de un solo uso, rechazo de duplicados, pérdida de rentabilidad, fills parciales, timeout incierto, parada y conciliación.
- No se enviaron órdenes reales ni se validaron claves de usuario o una ejecución completa contra Spot Testnet desde este entorno.

## Próximo trabajo

1. Ejecutar el panel en una red que permita Binance y observar estabilidad, volumen de mensajes y desconexiones.
2. Medir cobertura y reducir el universo de pares con datos de liquidez normalizados.
3. Añadir replay histórico y simulación con profundidad/filtros de exchange antes de valorar cualquier operativa.

## Documentación oficial

- [Spot REST API](https://developers.binance.com/en/docs/products/spot/rest-api)
- [Spot WebSocket Streams](https://developers.binance.com/en/docs/products/spot/web-socket-streams)
- [Market data only](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md)


### Evaluación con cuenta (solo lectura)

Conecta la cuenta en el panel: se activa «Usar mi cuenta», se elige un activo con saldo (priorizando USDC/USDS/USDT/EUR) y se limita el importe inicial al disponible. Puedes elegir otro activo o desactivar este modo para explorar con costos manuales. El saldo del scanner se consulta cada 15 segundos; después de 60 segundos sin actualizar se bloquean las rutas.

El scanner carga `exchangeInfo` desde el entorno del backend, prioriza pares del activo inicial y consulta automáticamente comisiones y precios de referencia de las 20 mejores rutas con margen bruto. Las consultas están limitadas a tres símbolos por segundo, con caché. Una ruta sin tarifas vigentes o reglas completas queda pendiente, nunca asume comisión cero. Se incluyen tasas taker, comprador/vendedor, especiales e impuestos. El factor BNB 0.75 significa pagar el 75% de la tasa estándar, es decir, una reducción del 25%.

El descuento se estima solo con ambos indicadores habilitados, saldo libre BNB suficiente para los tres tramos y una conversión directa BNB fresca disponible. Si no puede verificarse, se usa la tarifa sin descuento. Su costo económico se descuenta igualmente del resultado; no se confunde la salida con ganancia gratuita por pagar desde otro saldo. Se descarta conservadoramente el polvo de redondeo.

Las validaciones incluyen `canTrade`, saldo libre (sin fondos bloqueados), antigüedad, liquidez del primer nivel, LOT_SIZE, MARKET_LOT_SIZE y MIN_NOTIONAL/NOTIONAL aplicables a órdenes market. Para mínimos con promedio se exige que `avgPrice.mins` coincida con la ventana del filtro; si no coincide, la ruta se bloquea. Los filtros con ventana cero utilizan el último precio. Se muestran motivos de descarte.

Son comprobaciones preliminares: no certifican aceptación de una orden, restricciones regionales, filtros dinámicos o límites específicos de cuenta. La profundidad completa, fills parciales, latencia y pérdidas durante ejecución siguen pendientes. Testnet queda bloqueado para el scanner porque su stream todavía usa precios live. El paper trader sigue siendo exclusivamente USDT para no mezclar monedas en el historial existente.

Pruebas de las nuevas reglas: `npm run test:validation`.

El monitor conserva el stream durante la recarga de mercados al conectar la cuenta. Si `/api/markets` falla, utiliza exchangeInfo público live y muestra una advertencia con el error; la evaluación Testnet permanece bloqueada. La consulta de volumen 24 h es opcional y no bloquea los precios. El botón de reconexión también vuelve a cargar las reglas.


### Historial de oportunidades

El panel «Historial de oportunidades» registra automáticamente señales positivas observadas por el scanner, tanto en modo manual como con tarifas de cuenta. Se guarda en `data/opportunities.json` en el equipo donde corre el backend, mediante reemplazo atómico del archivo. Esta carpeta no se sube a GitHub. Conserva hasta 1.000 episodios; la interfaz muestra los últimos 50.

La misma ruta, parámetros e importe dentro de una sesión se agrupan mientras se observen de forma continua; una desaparición, cambio de parámetros o interrupción de más de cinco segundos genera un episodio nuevo. Se almacena la primera y última observación, mejor retorno estimado, costos configurados y número de observaciones. El período observado no certifica disponibilidad ejecutable. Reiniciar el servidor conserva los registros pero no presupone continuidad de las señales.

La captura sigue en el navegador: requiere pestaña abierta y backend encendido. Se toman las primeras 50 oportunidades positivas en cada evaluación y se envían observaciones agrupadas cada dos segundos; las señales más breves que la frecuencia del scanner pueden no detectarse. Hasta 20 observaciones se retienen temporalmente si falla el backend; aparece una advertencia si se desborda la cola. No se recuperan señales anteriores a esta actualización.

GET `/api/opportunities` lee registros; POST `/api/opportunities` admite exclusivamente observaciones JSON locales, con validación, límites de tamaño y protección de origen. Los registros son reportes del scanner, no órdenes ni instrucciones confiables de ejecución. El historial y paper trading no modifican el saldo real. El módulo de ejecución Spot separado permite órdenes únicamente cuando está habilitado y se envía un ciclo manual; nunca incorpora retiros.

Pruebas: `npm run test:history`.


### Ejecución Spot manual (dinero real)

El ejecutor está desactivado por defecto. No hace trading automáticamente cuando el scanner encuentra señales. Para habilitarlo, agrega `BINANCE_TRADING_ENABLED=true` al `.env` local y reinicia `npm run dev:api`. La clave necesita permiso de trading Spot; no requiere ni incorpora retiros, margin o futures. Con `BINANCE_TESTNET=true` usa exclusivamente el dominio de Spot Testnet y claves separadas.

En el panel «Ejecución Spot», pega los tres símbolos en el orden del ciclo o pulsa «Usar mejor ruta». Live inicia y termina exclusivamente en USDS, conforme al saldo y presupuesto acordados; Testnet usa USDT porque puede no ofrecer USDS. El máximo inicial por intento es 6,6 unidades, con reserva adicional del 5% dentro del presupuesto acumulado de 7. El presupuesto y las órdenes persisten en `data/execution-live.json` o `data/execution-testnet.json`. No se reinicia al actualizar la página ni después de un ciclo: está pensado para una prueba acotada, no como bot continuo. No borres estos diarios para eludir bloqueos o mientras haya órdenes pendientes.

«Verificar operación» consulta saldo, mercados, tarifas y mejores bid/ask desde el backend, deriva la ruta y calcula precios límite y cantidades redondeadas. Exige margen neto conservador superior a 1 pb y menor al 10%, y prueba la primera orden mediante `/api/v3/order/test`. No confía en el beneficio, precio, ruta o volumen enviados por el navegador. La previsualización expira en 15 segundos. «Ejecutar este ciclo con dinero real» consume ese token una sola vez y vuelve a validar todo antes de operar.

Cada tramo utiliza LIMIT FOK con precio alrededor del mejor bid/ask y margen de 5 pb, ajustado al tick del mercado. Se prueba la orden, se exige antigüedad inferior a 1,5 s y se registra el identificador antes del POST a Binance. Para el siguiente tramo usa la cantidad realmente recibida y deduce las comisiones cobradas en ese activo. No utiliza tus saldos preexistentes de los activos intermedios. Las comisiones en BNB u otros activos quedan en el detalle de fills, y los saldos reales se consultan después; la diferencia en USDS sola no es una ganancia neta si también se gastó BNB.

Un tramo expirado, parcial, rechazado, con comisiones incompletas o rentabilidad perdida detiene el ciclo. Un error de envío se consulta por `origClientOrderId` y nunca se reenvía. Puede dejar activos intermedios, que no se liquidan automáticamente. El estado REVIEW impide nuevos ciclos incluso después de reiniciar. «Consultar órdenes y saldos en Binance» concilia órdenes y trades para inspección, pero no reanuda operaciones ni elimina el bloqueo. Un reinicio con un ciclo en curso también exige revisión.

«Detener siguientes tramos» no cancela una orden ya enviada; bloquea los siguientes tramos y nuevas ejecuciones durante esa sesión del servidor. Las órdenes FOK no se dejan abiertas deliberadamente. El retorno previo es una estimación y el ciclo puede perder dinero. Los filtros dinámicos/restricciones de la cuenta se comprueban también mediante test de orden y Binance puede rechazar la orden real.

Endpoints locales: GET `/api/execution`; POST `/api/execution/preview`, `/api/execution/run`, `/api/execution/stop`, `/api/execution/reconcile`. Solo JSON, acceso local y límites de tamaño. No existen endpoints de retiros. Esta funcionalidad no se ha probado con fondos reales ni con claves de usuario en este entorno. Pruebas con un exchange simulado: `npm run test:execution`.

El ejecutor crea además un bloqueo de archivo durante cada ciclo para impedir operaciones concurrentes desde dos procesos locales que compartan el mismo diario. Si el servidor se interrumpe, un bloqueo o una ejecución pendiente requieren inspección; no se elimina automáticamente para continuar operando. Si no llegó a enviarse ninguna orden, la reserva del intento se libera.


### Selección y ejecución automáticas en el backend

Agrega al `.env`:

```env
BINANCE_TRADING_ENABLED=true
BINANCE_AUTO_ENABLED=true
AUTO_TRADE_AMOUNT=6.6
```

Con permisos Spot en la clave, el worker arranca junto con `npm run dev:api`. Selecciona hasta 900 mercados Spot LIMIT, prioriza el activo inicial (USDS live / USDT Testnet), mantiene un WebSocket propio del entorno y evalúa ciclos cada segundo. No necesita navegador abierto, pulsar «Conectar cuenta», copiar pares ni confirmar cada operación.

Las candidatas se ordenan por margen bruto. Prueba una de las 20 mejores por evaluación, con 30 segundos de espera por ruta para limitar consultas. Solo ejecuta cuando la previsualización del backend verifica saldo, filtros, precios límite y costos conservadores. El ejecutor vuelve a verificar antes del envío y entre tramos. Los registros de señales verificadas se guardan en el historial con una sesión del servidor, independientemente de la captura del navegador. Las candidatas brutas rechazadas no son ganancias ni se registran como oportunidades netas.

El límite acumulado sigue siendo 7, con reserva del 5% e importe máximo 6,6 por intento. No aumenta presupuesto ni reinvierte ganancias automáticamente. Un ciclo REVIEW, una parada o presupuesto insuficiente detienen el worker. «Detener siguientes tramos» detiene también la detección automática. Las desconexiones recuperables del stream se reconectan, pero nunca se reenvía una orden incierta. Errores de claves/firma y límites críticos detienen el worker.

El panel «Ejecución Spot» muestra estado automático, stream, ciclos, motivo de espera o parada y órdenes realizadas. Con automático configurado, el formulario manual queda deshabilitado para evitar confusión.

El backend necesita seguir encendido y conectado: cerrar el navegador no lo detiene; apagar/suspender el equipo, cerrar el proceso o perder conectividad sí impide evaluar/operar. Para funcionar cuando el equipo está apagado necesita despliegue en un servidor siempre encendido; ese despliegue no se ha realizado. No hay rentabilidad garantizada: puede permanecer esperando sin encontrar una ruta neta, y una ejecución puede perder dinero o dejar activos intermedios.

Pruebas del worker, sin fondos reales: `npm run test:automatic`.
