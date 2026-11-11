"""The `pub` module of PyPubSub: subscribe listeners to named topics and send messages to them."""

ALL_TOPICS = "ALL_TOPICS"
_listeners = {}


def _name(topic):
    return ".".join(topic) if isinstance(topic, (tuple, list)) else str(topic)


def subscribe(listener, topicName, **curriedArgs):
    ls = _listeners.setdefault(_name(topicName), [])
    if not any(l is listener or l == listener for l, _ in ls):
        ls.append((listener, curriedArgs))
        return listener, True
    return listener, False


def unsubscribe(listener, topicName):
    name = _name(topicName)
    _listeners[name] = [(l, c) for l, c in _listeners.get(name, []) if not (l is listener or l == listener)]


def unsubAll(topicName=None, listenerFilter=None, topicFilter=None):
    for name in ([_name(topicName)] if topicName else list(_listeners)):
        _listeners.pop(name, None)


def isSubscribed(listener, topicName):
    return any(l is listener or l == listener for l, _ in _listeners.get(_name(topicName), []))


def sendMessage(topicName, **msgData):
    name = _name(topicName)
    # a message to "a.b" also reaches the listeners of "a", as PyPubSub's topic tree does it
    parts = name.split(".")
    for depth in range(len(parts), 0, -1):
        for listener, curried in list(_listeners.get(".".join(parts[:depth]), [])):
            listener(**dict(curried, **msgData))
    for listener, curried in list(_listeners.get(ALL_TOPICS, [])):
        try:
            listener(**dict(curried, **msgData))
        except TypeError:
            pass


def getDefaultTopicMgr():
    return None


def setListenerExcHandler(handler):
    pass


def addTopicDefnProvider(*a, **k):
    pass


class Publisher:
    subscribe = staticmethod(subscribe)
    unsubscribe = staticmethod(unsubscribe)
    sendMessage = staticmethod(sendMessage)
    unsubAll = staticmethod(unsubAll)
    isSubscribed = staticmethod(isSubscribed)
