# Arbitrage Lab

Monitor de investigación de arbitraje triangular Spot con datos públicos de Binance. Incluye un escáner Python de terminal y un panel React con cotizaciones WebSocket. No gestiona cuentas y no envía órdenes.

## Panel React

Requisitos: Node.js 20.19+ o 22.12+.

```bash
npm install
npm run dev
```

El navegador consulta `exchangeInfo` y `ticker/24hr` para elegir hasta 900 pares Spot activos por volumen aproximado en USD. Luego se suscribe a sus streams individuales `<symbol>@bookTicker` por WebSocket. Los precios se mantienen localmente; no se guardan claves ni se envía información privada.

```bash
npm run build
npm run preview
npm run test:engine
```

El monitor muestra solo rutas cuyas tres cotizaciones tengan menos de dos segundos de antigüedad al calcular. Para cada pata usa el ask al comprar y el bid al vender, descuenta la comisión y el deslizamiento configurados, y limita el tamaño por la cantidad publicada en el mejor precio. El capital es virtual y cada oportunidad representa una simulación independiente.

Si el navegador bloquea la conexión a Binance por red, país o CORS, el panel lo indicará. No hay proxy para sortear bloqueos. El WebSocket del navegador responde automáticamente a los controles de protocolo y se rota antes del límite de 24 horas; al cerrarse, intenta reconectar con espera creciente.

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

- Cuatro pruebas del motor TypeScript y seis pruebas del motor Python aprobadas.
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
