# Arbitrage Lab

Monitor de investigación de arbitraje triangular Spot con datos públicos de Binance. Incluye un escáner Python de terminal y un panel React con cotizaciones WebSocket. Permite consultar una cuenta Binance en modo lectura mediante un backend local. No envía órdenes.

## Panel React

Requisitos: Node.js 20.19+ o 22.12+.

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

La API admite solo GET `/api/health`, `/api/account` y `/api/commission?symbol=BTCUSDT`; no contiene endpoints de órdenes o retiros. Firma HMAC en el servidor, sincroniza el reloj con Binance, limita el tiempo de espera y reutiliza respuestas por 15 s (saldo) o 60 s (comisiones). El backend escucha únicamente en loopback y rechaza hosts/orígenes externos. Esta configuración es para uso local; no publiques este servicio privado en internet.

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

- Cuatro pruebas del backend: firma HMAC/reloj, credenciales y errores, Testnet/comisiones, bloqueo de escritura y acceso externo.
- Siete pruebas del motor TypeScript (motor de rutas, paper trading, conexión, lotes y rechazos WebSocket) y seis pruebas del motor Python aprobadas.
- Demo Python ejecutada; una señal sintética pasa el umbral configurado.
- La consulta REST real anterior recibió 3.727 cotizaciones en 6,026 segundos y descartó el snapshot por latencia.
- La interfaz y la suscripción WebSocket quedan listas para comprobar localmente con `npm install` y `npm run dev`. En el entorno de autoría no está disponible el compilador TypeScript ni el acceso al registro de paquetes, así que no se pudo validar el bundle de Vite aquí.

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
