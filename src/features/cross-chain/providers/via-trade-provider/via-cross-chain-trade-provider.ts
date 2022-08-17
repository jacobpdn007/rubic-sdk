import {
    ViaCrossChainSupportedBlockchain,
    viaCrossChainSupportedBlockchains
} from 'src/features/cross-chain/providers/via-trade-provider/constants/via-cross-chain-supported-blockchain';
import { Via } from '@viaprotocol/router-sdk';
import { DEFAULT_API_KEY } from 'src/features/cross-chain/providers/via-trade-provider/constants/default-api-key';
import { ViaCrossChainTrade } from 'src/features/cross-chain/providers/via-trade-provider/via-cross-chain-trade';
import { BlockchainName, BlockchainsInfo, PriceToken, PriceTokenAmount, Web3Pure } from 'src/core';
import { Injector } from 'src/core/sdk/injector';
import { WrappedCrossChainTrade } from 'src/features/cross-chain/providers/common/models/wrapped-cross-chain-trade';
import { BridgeType, CROSS_CHAIN_TRADE_TYPE, TRADE_TYPE, TradeType } from 'src/features';
import { CrossChainTradeProvider } from 'src/features/cross-chain/providers/common/cross-chain-trade-provider';
import { RequiredCrossChainOptions } from 'src/features/cross-chain/models/cross-chain-options';
import BigNumber from 'bignumber.js';
import {
    IActionStepTool,
    IGetRoutesRequestParams,
    IGetRoutesResponse,
    IRoute
} from '@viaprotocol/router-sdk/dist/types';
import { ItType } from 'src/features/cross-chain/models/it-type';
import { bridges } from 'src/features/cross-chain/constants/bridge-type';
import { NATIVE_TOKEN_ADDRESS } from 'src/core/blockchain/constants/native-token-address';
import { FeeInfo } from 'src/features/cross-chain/providers/common/models/fee';
import { commonCrossChainAbi } from 'src/features/cross-chain/providers/common/constants/common-cross-chain-abi';
import { nativeTokensList } from 'src/core/blockchain/constants/native-tokens';
import {
    viaContractAbi,
    viaContractAddress
} from 'src/features/cross-chain/providers/via-trade-provider/constants/contract-data';
import { compareAddresses, notNull } from 'src/common';

interface ToolType extends IActionStepTool {
    type: 'swap' | 'cross';
}

export class ViaCrossChainTradeProvider extends CrossChainTradeProvider {
    public static isSupportedBlockchain(
        blockchain: BlockchainName
    ): blockchain is ViaCrossChainSupportedBlockchain {
        return viaCrossChainSupportedBlockchains.some(
            supportedBlockchain => supportedBlockchain === blockchain
        );
    }

    public readonly type = CROSS_CHAIN_TRADE_TYPE.VIA;

    private readonly viaConfig = {
        apiKey: DEFAULT_API_KEY,
        url: 'https://router-api.via.exchange'
    };

    protected get walletAddress(): string {
        return Injector.web3Private.address;
    }

    public isSupportedBlockchains(
        fromBlockchain: BlockchainName,
        toBlockchain: BlockchainName
    ): boolean {
        return (
            ViaCrossChainTradeProvider.isSupportedBlockchain(fromBlockchain) &&
            ViaCrossChainTradeProvider.isSupportedBlockchain(toBlockchain)
        );
    }

    public async calculate(
        from: PriceTokenAmount,
        toToken: PriceToken,
        options: RequiredCrossChainOptions
    ): Promise<Omit<WrappedCrossChainTrade, 'tradeType'> | null> {
        const fromBlockchain = from.blockchain;
        const toBlockchain = toToken.blockchain;
        if (
            !ViaCrossChainTradeProvider.isSupportedBlockchain(fromBlockchain) ||
            !ViaCrossChainTradeProvider.isSupportedBlockchain(toBlockchain)
        ) {
            return null;
        }

        try {
            const fromChainId = BlockchainsInfo.getBlockchainByName(fromBlockchain).id;
            const toChainId = BlockchainsInfo.getBlockchainByName(toBlockchain).id;

            const via = new Via({
                ...this.viaConfig,
                timeout: options.timeout
            });

            const pages = await via.routesPages();
            const params: IGetRoutesRequestParams = {
                fromChainId,
                fromTokenAddress: from.address,
                fromAmount: parseInt(from.stringWeiAmount),
                toChainId,
                toTokenAddress: toToken.address,
                fromAddress: viaContractAddress,
                multiTx: false,
                limit: 1
            };
            const wrappedRoutes = await Promise.allSettled(
                [...Array(pages)].map((_, i) =>
                    via.getRoutes({
                        ...params,
                        offset: i + 1
                    })
                )
            );
            const routes = (
                wrappedRoutes.filter(
                    wrappedRoute =>
                        wrappedRoute.status === 'fulfilled' && wrappedRoute.value.routes.length
                ) as PromiseFulfilledResult<IGetRoutesResponse>[]
            )
                .map(wrappedRoute => wrappedRoute.value.routes)
                .flat();
            const filteredRoutes = await this.getFilteredRoutes(fromBlockchain, via, routes);
            if (!filteredRoutes.length) {
                return null;
            }

            const [fromTokenPrice, nativeTokenPrice] = await this.getTokensPrice(fromBlockchain, [
                {
                    address: from.address,
                    price: from.price
                },
                { address: NATIVE_TOKEN_ADDRESS }
            ]);
            const bestRoute = await this.getBestRoute(toToken, nativeTokenPrice!, filteredRoutes);

            from = new PriceTokenAmount({
                ...from.asStructWithAmount,
                price: fromTokenPrice!
            });
            const to = new PriceTokenAmount({
                ...toToken.asStruct,
                weiAmount: new BigNumber(bestRoute.toTokenAmount)
            });
            const toTokenAmountMin = Web3Pure.fromWei(
                to.weiAmountMinusSlippage((bestRoute.slippage || 0) / 100),
                to.decimals
            );

            const gasData = options.gasCalculation === 'enabled' ? null : null;

            const additionalFee = bestRoute.actions[0]?.additionalProviderFee;
            const cryptoFeeAmount = Web3Pure.fromWei(additionalFee?.amount.toString() || 0);
            const cryptoFeeSymbol = additionalFee?.token.symbol;
            const feeInfo = {
                ...(await this.getFeeInfo(fromBlockchain, options.providerAddress, from)),
                cryptoFee: additionalFee
                    ? {
                          amount: cryptoFeeAmount,
                          tokenSymbol: cryptoFeeSymbol!
                      }
                    : null
            };

            const nativeToken = BlockchainsInfo.getBlockchainByName(from.blockchain).nativeCoin;
            const cryptoFeeToken = new PriceTokenAmount({
                ...nativeToken,
                price: nativeTokenPrice || new BigNumber(0),
                tokenAmount: cryptoFeeAmount
            });

            const itType = this.parseItProviders(bestRoute);
            const bridgeType = this.parseBridge(bestRoute);

            return {
                trade: new ViaCrossChainTrade(
                    {
                        from,
                        to,
                        route: bestRoute,
                        gasData,
                        priceImpact: 0, // @TODO add price impact
                        toTokenAmountMin,
                        feeInfo,
                        cryptoFeeToken,
                        itType,
                        bridgeType
                    },
                    options.providerAddress
                )
            };
        } catch (err: unknown) {
            return {
                trade: null,
                error: CrossChainTradeProvider.parseError(err)
            };
        }
    }

    private async getFilteredRoutes(
        fromBlockchain: BlockchainName,
        via: Via,
        routes: IRoute[]
    ): Promise<IRoute[]> {
        const whitelistedContracts = (
            await Injector.web3PublicService
                .getWeb3Public(fromBlockchain)
                .callContractMethod<string[]>(
                    viaContractAddress,
                    viaContractAbi,
                    'getAvailableRouters'
                )
        ).map(contract => contract.toLowerCase());

        const whitelistedRoutes = await Promise.all(
            routes.map(async route => {
                try {
                    const tx = await via.buildTx({
                        routeId: route.routeId,
                        fromAddress: viaContractAddress,
                        receiveAddress: viaContractAddress,
                        numAction: 0
                    });
                    if (
                        whitelistedContracts.find(whitelistedContract =>
                            compareAddresses(whitelistedContract, tx.to)
                        )
                    ) {
                        return route;
                    }

                    console.debug('Not whitelisted address:', tx.to);
                    return null;
                } catch (err) {
                    console.debug('buildTx error:', err);
                    return null;
                }
            })
        );
        return whitelistedRoutes.filter(notNull);
    }

    private async getBestRoute(
        toToken: PriceToken,
        nativeTokenPrice: BigNumber | null,
        routes: IRoute[]
    ): Promise<IRoute> {
        const toTokenPrice = (await this.getTokensPrice(toToken.blockchain, [toToken]))[0];

        const sortedRoutes = routes.sort((routeA, routeB) => {
            if (!toTokenPrice) {
                return new BigNumber(routeB.toTokenAmount).comparedTo(routeA.toTokenAmount);
            }

            const nativeTokenAmountA = routeA.actions[0]?.additionalProviderFee?.amount;
            const nativeTokenAmountB = routeB.actions[0]?.additionalProviderFee?.amount;

            const routeProfitA = toTokenPrice
                .multipliedBy(routeA.toTokenAmount)
                .minus(nativeTokenPrice?.multipliedBy(nativeTokenAmountA?.toString() || 0) || 0);
            const routeProfitB = toTokenPrice
                .multipliedBy(routeB.toTokenAmount)
                .minus(nativeTokenPrice?.multipliedBy(nativeTokenAmountB?.toString() || 0) || 0);

            return routeProfitB.comparedTo(routeProfitA);
        });
        return sortedRoutes[0]!;
    }

    private getTokensPrice(
        blockchain: BlockchainName,
        tokens: {
            address: string;
            price?: BigNumber;
        }[]
    ): Promise<(BigNumber | null)[]> {
        const chainId = BlockchainsInfo.getBlockchainByName(blockchain).id;

        return Injector.httpClient
            .get<{ [chainId: number]: { [address: string]: { USD: number } } }>(
                'https://explorer-api.via.exchange/v1/token_price',
                {
                    params: {
                        chain: chainId,
                        tokens_addresses: tokens.map(token => token.address).join(',')
                    }
                }
            )
            .then(response =>
                tokens.map(token => new BigNumber(response[chainId]![token.address]!.USD))
            )
            .catch(() => tokens.map(token => token.price || null));
    }

    private parseItProviders(route: IRoute): ItType {
        const steps = route.actions[0]?.steps;

        const firstStep = steps?.[0];
        const firstItProvider =
            (firstStep?.tool as ToolType).type === 'swap' ? firstStep?.tool.name : undefined;

        const lastStep = steps?.reverse()[0];
        const secondItProvider =
            steps?.length && steps.length > 1 && (lastStep?.tool as ToolType).type === 'swap'
                ? lastStep?.tool.name
                : undefined;

        return {
            from: this.parseTradeType(firstItProvider),
            to: this.parseTradeType(secondItProvider)
        };
    }

    private parseTradeType(type: string | undefined): TradeType | undefined {
        if (!type) {
            return undefined;
        }

        type = type.toUpperCase();
        const foundType = Object.values(TRADE_TYPE).find(
            tradeType => tradeType.split('_').join('') === type
        );
        if (foundType) {
            return foundType;
        }

        switch (type) {
            case '1INCH':
                return TRADE_TYPE.ONE_INCH;
            case '1SOL':
                return TRADE_TYPE.ONE_SOL;
            case 'DODOEX':
                return TRADE_TYPE.DODO;
            case 'TRADERJOE':
                return TRADE_TYPE.JOE;
            case 'UNISWAP':
                return TRADE_TYPE.UNISWAP_V2;
            default:
                return undefined;
        }
    }

    private parseBridge(route: IRoute): BridgeType {
        const bridgeApi = route.actions[0]?.steps.find(
            step => (step.tool as ToolType).type === 'cross'
        )?.tool.name;
        if (!bridgeApi) {
            return undefined;
        }

        return bridges.find(bridge => bridge === bridgeApi.split(' ')[0]?.toLowerCase());
    }

    protected override async getFeeInfo(
        fromBlockchain: ViaCrossChainSupportedBlockchain,
        providerAddress: string,
        percentFeeToken: PriceTokenAmount
    ): Promise<FeeInfo> {
        return {
            fixedFee: {
                amount: await this.getFixedFee(
                    fromBlockchain,
                    providerAddress,
                    viaContractAddress,
                    commonCrossChainAbi
                ),
                tokenSymbol: nativeTokensList[fromBlockchain].symbol
            },
            platformFee: {
                percent: await this.getFeePercent(
                    fromBlockchain,
                    providerAddress,
                    viaContractAddress,
                    commonCrossChainAbi
                ),
                tokenSymbol: percentFeeToken.symbol
            },
            cryptoFee: null
        };
    }
}
