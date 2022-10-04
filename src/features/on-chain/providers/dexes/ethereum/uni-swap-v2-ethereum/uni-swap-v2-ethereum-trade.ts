import {
    UniswapV2AbstractTrade,
    UniswapV2TradeStruct
} from 'src/features/on-chain/providers/dexes/abstract/uniswap-v2-abstract/uniswap-v2-abstract-trade';
import {
    ON_CHAIN_TRADE_TYPE,
    OnChainTradeType
} from 'src/features/on-chain/providers/models/on-chain-trade-type';
import { UNISWAP_V2_ETHEREUM_CONTRACT_ADDRESS } from 'src/features/on-chain/providers/dexes/ethereum/uni-swap-v2-ethereum/constants';

export class UniSwapV2EthereumTrade extends UniswapV2AbstractTrade {
    public static get type(): OnChainTradeType {
        return ON_CHAIN_TRADE_TYPE.UNISWAP_V2;
    }

    protected readonly contractAddress = UNISWAP_V2_ETHEREUM_CONTRACT_ADDRESS;

    constructor(tradeStruct: UniswapV2TradeStruct) {
        super(tradeStruct);
    }
}
