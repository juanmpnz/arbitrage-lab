import unittest
from decimal import Decimal as D
from bot import fixture, graph, scan


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.markets, self.quotes = fixture()

    def test_buy_uses_ask_sell_uses_bid(self):
        g = graph(self.markets, self.quotes)
        self.assertEqual(g['USDT']['BTC'].rate, 1 / D('60000'))
        self.assertEqual(g['BTC']['USDT'].rate, D('59990'))

    def test_three_leg_costs(self):
        rows = scan(graph(self.markets, self.quotes), 'USDT', D('68'), D('10'), D('5'))
        self.assertEqual(rows[0]['route'], ['USDT', 'BTC', 'ETH', 'USDT'])
        expected = D('68') / D('60000') * D('.999') * D('.9995')
        expected = expected / D('.05') * D('.999') * D('.9995')
        expected = expected * D('3060') * D('.999') * D('.9995')
        self.assertAlmostEqual(D(rows[0]['output']), expected, places=20)

    def test_costs_remove_apparent_profit(self):
        rows = scan(graph(self.markets, self.quotes), 'USDT', D('68'), D('100'), D('50'))
        self.assertTrue(all(D(r['net_bps']) < 0 for r in rows))

    def test_insufficient_liquidity_excludes_route(self):
        self.quotes[0]['askQty'] = '.00001'
        rows = scan(graph(self.markets, self.quotes), 'USDT', D('68'), D('0'), D('0'))
        self.assertFalse(any(r['route'] == ['USDT', 'BTC', 'ETH', 'USDT'] for r in rows))

    def test_halted_market(self):
        self.markets[1]['status'] = 'HALT'
        self.assertEqual(scan(graph(self.markets, self.quotes), 'USDT', D('68'), D('0'), D('0')), [])

    def test_invalid_book(self):
        self.quotes[1]['bidPrice'] = 'NaN'
        self.assertEqual(scan(graph(self.markets, self.quotes), 'USDT', D('68'), D('0'), D('0')), [])


if __name__ == '__main__':
    unittest.main()
